#!/usr/bin/env python3
"""Prepare/release one independent Game Studio installation through AWS CLI.

Without --execute this script performs local validation and prints the next
operation; it never contacts AWS. --execute additionally requires the explicit
--authorize-aws-charges flag. No Core, DNS, IAM grants or existing app is changed.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
import uuid
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
UUID = re.compile(r'^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$')


def fail(message):
    raise RuntimeError(message)


def run(args, **kwargs):
    return subprocess.run([str(v) for v in args], cwd=ROOT, check=True, **kwargs)


def read_json(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')
    Path(path).chmod(0o600)


def exact_origin(value):
    u = urlsplit(value)
    if not isinstance(value, str) or u.scheme != 'https' or not u.hostname or u.username is not None or u.password is not None or '?' in value or '#' in value or u.query or u.fragment or u.path or u.port:
        fail('Use exact HTTPS origins without a port, path, credentials, query or fragment.')
    if not re.fullmatch(r'[a-z0-9.-]+', u.netloc) or value != 'https://' + u.netloc:
        fail('Invalid HTTPS origin.')
    return value


def public_config(path):
    value = read_json(path)
    for key in ['issuer', 'application_origin']:
        exact_origin(value.get(key, ''))
    if value.get('redirect_uri') != value['application_origin'] + '/oauth/callback':
        fail('The registered callback must be the exact Game Studio origin + /oauth/callback.')
    for key in ['organization_id', 'service_id']:
        if not UUID.fullmatch(value.get(key, '')):
            fail('Core registration must include verified organization and service UUIDs.')
    if not isinstance(value.get('browser_client_id'), str) or not value['browser_client_id']:
        fail('Core registration is missing its public PKCE client.')
    if any(key in value for key in ['client_secret', 'access_token', 'refresh_token', 'password']):
        fail('Supply only Core public registration JSON, never credentials.')
    return value


def clean_commit():
    if run(['git', 'status', '--porcelain'], stdout=subprocess.PIPE, text=True).stdout.strip():
        fail('Commit all source changes first. Deploy only a clean reviewed checkout.')
    return run(['git', 'rev-parse', 'HEAD'], stdout=subprocess.PIPE, text=True).stdout.strip()


class Deployment:
    def __init__(self, args):
        self.args = args
        self.directory = Path(args.output).expanduser().resolve()
        if self.directory.is_relative_to(ROOT):
            fail('Choose a private receipt directory outside the repository.')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)

    def aws(self, *arguments):
        command = [self.args.aws_cli, '--profile', self.args.profile, '--region', self.args.region, '--no-cli-pager', '--output', 'json', *arguments]
        result = subprocess.run(command, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=dict(os.environ, AWS_PAGER='', AWS_CLI_AUTO_PROMPT='off'))
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or 'AWS CLI operation failed.')
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def verify_account(self):
        actual = self.aws('sts', 'get-caller-identity')
        if actual.get('Account') != self.args.expected_account:
            fail('AWS profile resolves to another account. No deployment was attempted.')
        save(self.directory / 'account.json', {'account': actual['Account'], 'region': self.args.region, 'profile': self.args.profile})

    def stack(self, name):
        try:
            return self.aws('cloudformation', 'describe-stacks', '--stack-name', name)['Stacks'][0]
        except RuntimeError as error:
            if 'does not exist' not in str(error):
                raise
            return None

    def outputs(self, name):
        current = self.stack(name)
        if not current or current['StackStatus'] not in ['CREATE_COMPLETE', 'UPDATE_COMPLETE']:
            fail('The stack is not ready; inspect CloudFormation before continuing.')
        return {item['OutputKey']: item['OutputValue'] for item in current.get('Outputs', [])}

    def apply_stack(self, name, template, values, core=None):
        if not re.fullmatch(r'game-studio-[a-z0-9-]{3,90}', name):
            fail('Use a dedicated game-studio-… stack name; existing Axolotl/Core names are rejected.')
        before = self.stack(name)
        if before:
            tags = {item['Key']: item['Value'] for item in before.get('Tags', [])}
            if tags.get('nce:application-family') != 'game-studio':
                fail('Refusing a stack not tagged as an independent Game Studio installation.')
            if before['StackStatus'] not in ['CREATE_COMPLETE', 'UPDATE_COMPLETE']:
                fail('The existing stack needs operator recovery before another release.')
            if core:
                old = {item['ParameterKey']: item['ParameterValue'] for item in before['Parameters']}
                for key in ['ApplicationOrigin', 'CoreIssuer', 'CoreOrganizationId', 'CoreServiceId', 'CoreCredentialsParameter']:
                    if old.get(key) != values.get(key):
                        fail('Core placement, origin and private client reference are immutable. Use a new installation.')
        parameters = [{'ParameterKey': key, 'ParameterValue': str(value)} for key, value in values.items()]
        parameter_path = self.directory / (name + '-parameters.json')
        save(parameter_path, parameters)
        change_name = 'game-studio-' + uuid.uuid4().hex
        self.aws('cloudformation', 'validate-template', '--template-body', 'file://' + str(template))
        self.aws('cloudformation', 'create-change-set', '--stack-name', name, '--change-set-name', change_name,
                 '--change-set-type', 'UPDATE' if before else 'CREATE', '--template-body', 'file://' + str(template),
                 '--parameters', 'file://' + str(parameter_path), '--capabilities', 'CAPABILITY_IAM',
                 '--tags', 'Key=nce:application-family,Value=game-studio')
        try:
            self.aws('cloudformation', 'wait', 'change-set-create-complete', '--stack-name', name, '--change-set-name', change_name)
        except RuntimeError:
            change = self.aws('cloudformation', 'describe-change-set', '--stack-name', name, '--change-set-name', change_name)
            if before and 'didn\'t contain changes' in change.get('StatusReason', ''):
                self.aws('cloudformation', 'delete-change-set', '--stack-name', name, '--change-set-name', change_name)
                return self.outputs(name)
            raise
        change = self.aws('cloudformation', 'describe-change-set', '--stack-name', name, '--change-set-name', change_name)
        save(self.directory / (name + '-change-set.json'), change)
        for item in change.get('Changes', []):
            resource = item.get('ResourceChange', {})
            if resource.get('Action') == 'Remove' or resource.get('Replacement') in ['True', 'Conditional']:
                fail('Change set would remove/replace a resource. It was NOT executed; review the retained plan in AWS.')
            print(resource.get('Action'), resource.get('LogicalResourceId'), flush=True)
        # CloudFormation pre-deployment validation is enabled by default.
        self.aws('cloudformation', 'execute-change-set', '--stack-name', name, '--change-set-name', change_name)
        self.aws('cloudformation', 'wait', 'stack-update-complete' if before else 'stack-create-complete', '--stack-name', name)
        outputs = self.outputs(name)
        save(self.directory / (name + '-outputs.json'), outputs)
        return outputs

    def frontend(self):
        template = ROOT / 'infra/aws/frontend.template.json'
        values = {'ApplicationName': self.args.name, 'BranchName': self.args.branch}
        save(self.directory / 'frontend-plan.json', {'stack': self.args.stack, 'template': str(template), 'parameters': values})
        if not self.args.execute:
            print('Prepared frontend-plan.json. No AWS request was made. To provision the independent Amplify app and artifact bucket, repeat with --execute --authorize-aws-charges.')
            return
        self.verify_account()
        outputs = self.apply_stack(self.args.stack, template, values)
        print('Frontend hosting prepared. Register this exact origin in Core:', outputs['Origin'])
        print('Dedicated artifact bucket:', outputs['ArtifactBucket'])

    def api(self):
        core = public_config(self.args.core_public)
        config = read_json(self.args.studio_config)
        compact = json.dumps(config, separators=(',', ':'), ensure_ascii=False)
        if len(compact.encode()) > 2048:
            fail('The nonsecret studio configuration must fit within 2048 UTF-8 bytes.')
        run(['node', 'scripts/write-hosting-headers.mjs', self.args.studio_config, '--output', self.directory / 'customHttp.yml'])
        if not re.fullmatch(r'/game-studio/[a-zA-Z0-9/_-]+', self.args.credentials_parameter):
            fail('Use an independent /game-studio/…/core-resource-client SecureString, not an Axolotl secret.')
        commit = clean_commit()
        archive = self.directory / 'game-studio-api.zip'
        run([sys.executable, 'scripts/package-api.py', '--output', archive])
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        key = f'releases/{commit}/{digest}/game-studio-api.zip'
        values = {'ApplicationOrigin': core['application_origin'], 'CoreIssuer': core['issuer'], 'CoreOrganizationId': core['organization_id'],
                  'CoreServiceId': core['service_id'], 'CoreCredentialsParameter': self.args.credentials_parameter,
                  'AllowedOrigins': ','.join(dict.fromkeys([core['application_origin'], *[host['origin'] for host in config['hosts']]])),
                  'LambdaCodeBucket': self.args.code_bucket, 'LambdaCodeKey': key, 'LambdaReservedConcurrency': self.args.concurrency, 'GameStudioConfigJson': compact}
        receipt = {'status': 'PREPARED', 'commit': commit, 'stack': self.args.stack, 'codeSha256': base64.b64encode(bytes.fromhex(digest)).decode(),
                   'archiveSha256': digest, 'applicationOrigin': core['application_origin'], 'studioConfigSha256': hashlib.sha256(compact.encode()).hexdigest(), 'codeKey': key}
        save(self.directory / 'api-plan.json', {'parameters': values, **receipt})
        if not self.args.execute:
            print('Prepared deterministic API archive and api-plan.json. No AWS request was made. Repeat with --execute --authorize-aws-charges to apply.')
            return
        self.verify_account()
        self.aws('s3api', 'head-bucket', '--bucket', self.args.code_bucket, '--expected-bucket-owner', self.args.expected_account)
        self.aws('s3api', 'put-object', '--bucket', self.args.code_bucket, '--key', key, '--body', str(archive),
                 '--server-side-encryption', 'AES256', '--content-type', 'application/zip', '--expected-bucket-owner', self.args.expected_account)
        outputs = self.apply_stack(self.args.stack, ROOT / 'infra/aws/game-studio.template.json', values, core)
        actual = self.aws('lambda', 'get-function-configuration', '--function-name', outputs['FunctionName'])
        if actual.get('CodeSha256') != receipt['codeSha256'] or actual.get('LastUpdateStatus') != 'Successful':
            fail('Lambda did not report the exact reviewed archive as successfully updated.')
        with urlopen(outputs['ApiUrl'] + '/health', timeout=20) as response:
            if response.status != 200:
                fail('The released API health endpoint did not return 200.')
        receipt.update(status='API_VERIFIED', outputs=outputs, account=self.args.expected_account, region=self.args.region)
        save(self.directory / 'api-release.json', receipt)
        print('API released and exact archive verified. Publish the frontend next using api-release.json.')

    def publish(self):
        core = public_config(self.args.core_public)
        api = read_json(self.args.api_receipt)
        commit = clean_commit()
        config = json.dumps(read_json(self.args.studio_config), separators=(',', ':'), ensure_ascii=False)
        if (api.get('status') != 'API_VERIFIED' or api.get('commit') != commit or api.get('applicationOrigin') != core['application_origin']
                or api.get('studioConfigSha256') != hashlib.sha256(config.encode()).hexdigest()):
            fail('Release the matching reviewed API/configuration first. Frontend publication is blocked.')
        run(['node', 'scripts/write-core-config.mjs', self.args.core_public, api['outputs']['ApiUrl']])
        env = dict(os.environ, VITE_APP_MODE='nce', GAME_STUDIO_CONFIG_JSON=config)
        run(['npm', 'run', 'build'], env=env)
        run(['node', 'scripts/write-hosting-headers.mjs', self.args.studio_config, '--output', ROOT / 'dist/customHttp.yml'])
        archive = self.directory / 'frontend.zip'
        expanded = 0
        with ZipFile(archive, 'w', ZIP_DEFLATED) as packed:
            for path in sorted((ROOT / 'dist').rglob('*')):
                if path.is_symlink():
                    fail('The frontend artifact may not contain symbolic links.')
                if path.is_file():
                    expanded += path.stat().st_size
                    if expanded > 200 * 1024 * 1024:
                        fail('The expanded frontend exceeds the reviewed 200 MiB artifact bound.')
                    packed.write(path, str(path.relative_to(ROOT / 'dist')))
        receipt = {'status': 'PREPARED', 'commit': commit, 'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'apiStack': api['stack']}
        save(self.directory / 'frontend-plan.json', receipt)
        if not self.args.execute:
            print('Prepared frontend.zip with exact-host headers. No AWS request was made. Repeat with --execute --authorize-aws-charges to publish.')
            return
        self.verify_account()
        if api.get('account') != self.args.expected_account or api.get('region') != self.args.region:
            fail('The API receipt belongs to another account/region.')
        outputs = self.outputs(self.args.stack)
        if outputs['Origin'] != core['application_origin']:
            fail('The generated Amplify origin differs from the immutable Core registration. Custom origins require separate verified domain onboarding.')
        actual = self.aws('lambda', 'get-function-configuration', '--function-name', api['outputs']['FunctionName'])
        if actual.get('CodeSha256') != api['codeSha256']:
            fail('The API changed after its receipt. Do not publish a mismatched frontend.')
        deployment = self.aws('amplify', 'create-deployment', '--app-id', outputs['AmplifyAppId'], '--branch-name', outputs['BranchName'])
        upload = urlsplit(deployment['zipUploadUrl'])
        if upload.scheme != 'https' or not upload.hostname or not upload.hostname.endswith('.amazonaws.com'):
            fail('Amplify returned an unexpected artifact upload endpoint.')
        # Never print or persist the one-use presigned URL.
        with urlopen(Request(deployment['zipUploadUrl'], data=archive.read_bytes(), method='PUT', headers={'Content-Type': 'application/zip'}), timeout=120) as response:
            if response.status not in [200, 201, 204]:
                fail('Amplify did not accept the frontend artifact.')
        self.aws('amplify', 'start-deployment', '--app-id', outputs['AmplifyAppId'], '--branch-name', outputs['BranchName'], '--job-id', deployment['jobId'])
        for _ in range(120):
            job = self.aws('amplify', 'get-job', '--app-id', outputs['AmplifyAppId'], '--branch-name', outputs['BranchName'], '--job-id', deployment['jobId'])['job']['summary']
            if job['status'] == 'SUCCEED':
                receipt.update(status='FRONTEND_PUBLISHED', jobId=deployment['jobId'], origin=core['application_origin'])
                save(self.directory / 'frontend-release.json', receipt)
                print('Frontend published:', core['application_origin'], 'at', commit)
                print('Complete the browser acceptance checklist in deployment/README.md before marking this live-verified.')
                return
            if job['status'] in ['FAILED', 'CANCELLED']:
                fail('Amplify publication failed. Inspect the job; this script does not destroy resources or roll back data.')
            time.sleep(10)
        fail('Amplify publication timed out; inspect the existing job before starting another release.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['frontend', 'api', 'publish'])
    parser.add_argument('--profile', required=True)
    parser.add_argument('--region', required=True)
    parser.add_argument('--expected-account', required=True)
    parser.add_argument('--stack', required=True)
    parser.add_argument('--output', required=True, help='Private receipt directory outside this repository.')
    parser.add_argument('--aws-cli', default='aws')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--authorize-aws-charges', action='store_true')
    parser.add_argument('--name', default='game-studio')
    parser.add_argument('--branch', default='production')
    parser.add_argument('--core-public')
    parser.add_argument('--studio-config')
    parser.add_argument('--credentials-parameter')
    parser.add_argument('--code-bucket')
    parser.add_argument('--concurrency', type=int, choices=[0, 1, 2], default=0)
    parser.add_argument('--api-receipt')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9]{12}', args.expected_account) or not re.fullmatch(r'[a-z]{2}(?:-[a-z]+)+-[0-9]', args.region):
        parser.error('An explicit expected AWS account and region are required.')
    if args.execute and not args.authorize_aws_charges:
        parser.error('--execute requires --authorize-aws-charges; this is an intentional billable operation.')
    required = ['core_public', 'studio_config', 'credentials_parameter', 'code_bucket'] if args.action == 'api' else ['core_public', 'studio_config', 'api_receipt'] if args.action == 'publish' else []
    for field in required:
        if not getattr(args, field):
            parser.error('--' + field.replace('_', '-') + ' is required for ' + args.action)
    if not re.fullmatch(r'game-studio-[a-z0-9-]{3,90}', args.stack):
        parser.error('Use an independent game-studio-… stack name.')
    deployment = Deployment(args)
    getattr(deployment, args.action)()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print('Stopped:', str(error), file=sys.stderr)
        sys.exit(1)
