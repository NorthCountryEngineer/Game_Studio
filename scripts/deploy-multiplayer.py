"""Package or release the additive Game Studio multiplayer extension.

Planning is offline. Execution verifies the exact existing Core application,
derives its public-only table and origin, and refuses removal or replacement.
It never changes the Core-managed stack, permissions boundary or credentials.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('studio_deploy', ROOT / 'scripts/deploy-aws.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
spec = importlib.util.spec_from_file_location('studio_package', ROOT / 'scripts/package-api.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def binding(stack, resources, application):
    tags = {row['Key']: row['Value'] for row in stack.get('Tags', [])}
    values = {row['ParameterKey']: row['ParameterValue'] for row in stack.get('Parameters', [])}
    if (stack.get('StackStatus') not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE'} or
            tags.get('nce:application') != application or values.get('ApplicationIdentifier') != application or
            values.get('Archetype') != 'amplify-game-studio'):
        raise RuntimeError('The existing stack is not this verified Game Studio application.')
    table = [row['PhysicalResourceId'] for row in resources
             if row['LogicalResourceId'] == 'PublishedGames' and row['ResourceType'] == 'AWS::DynamoDB::Table']
    if len(table) != 1 or not re.fullmatch(r'[A-Za-z0-9_.-]{3,255}', table[0]):
        raise RuntimeError('The existing published-games table could not be identified.')
    for key in ['CoreOrganizationId', 'CoreServiceId']:
        if not deployment.UUID.fullmatch(values.get(key, '')):
            raise RuntimeError('The existing application identity is invalid.')
    return {'ApplicationIdentifier': application,
            'ApplicationOrigin': deployment.exact_origin(values.get('ApplicationOrigin', '')),
            'CoreOrganizationId': values['CoreOrganizationId'], 'CoreServiceId': values['CoreServiceId'],
            'PublishedGamesTable': table[0], 'LambdaCodeBucket': values['LambdaCodeBucket']}


def preserve_binding(previous, values):
    if not previous:
        return
    old = {row['ParameterKey']: row['ParameterValue'] for row in previous.get('Parameters', [])}
    for key in ['ApplicationIdentifier', 'ApplicationOrigin', 'CoreOrganizationId', 'CoreServiceId', 'PublishedGamesTable']:
        if old.get(key) != values[key]:
            raise RuntimeError('An extension cannot be reassigned to a different application, origin or table.')


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--output', required=True, type=Path)
    result.add_argument('--core-stack', required=True)
    result.add_argument('--application-id', required=True)
    result.add_argument('--stack', required=True)
    result.add_argument('--profile', required=True)
    result.add_argument('--expected-account', required=True)
    result.add_argument('--region', default='us-east-1')
    result.add_argument('--aws-cli', default='aws')
    result.add_argument('--execute', action='store_true')
    result.add_argument('--authorize-aws-charges', action='store_true')
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    if (not deployment.UUID.fullmatch(args.application_id) or not re.fullmatch(r'\d{12}', args.expected_account) or
            not re.fullmatch(r'nce-[a-z0-9-]{3,100}', args.core_stack) or
            not re.fullmatch(r'game-studio-[a-z0-9-]{3,80}-multiplayer', args.stack)):
        raise RuntimeError('Use an exact application, account, Core stack and dedicated multiplayer stack.')
    if args.execute and not args.authorize_aws_charges:
        raise RuntimeError('Execution requires --authorize-aws-charges after reviewing the source and plan.')
    operation = deployment.Deployment(args)
    archive = operation.directory / 'multiplayer-api.zip'
    digest = package.package_api(archive)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    template = ROOT / 'infra/aws/multiplayer.template.json'
    deployment.save(operation.directory / 'multiplayer-plan.json', {'status': 'PREPARED',
        'sourceCommit': commit, 'archiveSha256': digest, 'templateSha256': hashlib.sha256(template.read_bytes()).hexdigest(),
        'coreStack': args.core_stack, 'applicationId': args.application_id, 'stack': args.stack,
        'permissions': 'New extension role: public-edition read/condition-check, new room table, own socket callbacks and logs only.',
        'preservation': 'No existing stack, role, private table, credential, DNS, host registration or model permission changes.'})
    if not args.execute:
        print('Prepared multiplayer-plan.json and exact API archive. No AWS request was made.')
        return 0
    deployment.clean_commit()
    operation.verify_account()
    existing = operation.stack(args.core_stack)
    if not existing:
        raise RuntimeError('The verified existing application stack is required.')
    resources = operation.aws('cloudformation', 'list-stack-resources', '--stack-name', args.core_stack)['StackResourceSummaries']
    values = binding(existing, resources, args.application_id)
    values['LambdaCodeKey'] = f'code/multiplayer/{commit}/{digest}/api.zip'
    preserve_binding(operation.stack(args.stack), values)
    operation.aws('cloudformation', 'validate-template', '--template-body', 'file://' + str(template))
    operation.aws('s3api', 'head-bucket', '--bucket', values['LambdaCodeBucket'], '--expected-bucket-owner', args.expected_account)
    operation.aws('s3api', 'put-object', '--bucket', values['LambdaCodeBucket'], '--key', values['LambdaCodeKey'],
                  '--body', str(archive), '--server-side-encryption', 'AES256', '--content-type', 'application/zip',
                  '--expected-bucket-owner', args.expected_account)
    outputs = operation.apply_stack(args.stack, template, values)
    actual = operation.aws('lambda', 'get-function-configuration', '--function-name', outputs['FunctionName'])
    import base64
    if actual.get('CodeSha256') != base64.b64encode(bytes.fromhex(digest)).decode() or actual.get('LastUpdateStatus') != 'Successful':
        raise RuntimeError('The relay Lambda does not match the reviewed source archive.')
    with urlopen(outputs['ApiUrl'] + '/health', timeout=20) as response:
        if response.status != 200 or json.loads(response.read(4096)) != {'status': 'ok'}:
            raise RuntimeError('The released relay health check failed.')
    after = operation.stack(args.core_stack)
    if existing != after:
        raise RuntimeError('The existing Core application stack changed during this isolated extension release.')
    receipt = {'status': 'VERIFIED', 'sourceCommit': commit, 'archiveSha256': digest,
               'coreStackUnchanged': True, 'applicationId': args.application_id, 'outputs': outputs,
               'publicConfig': {'version': 1, 'apiUrl': outputs['ApiUrl']}}
    deployment.save(operation.directory / 'multiplayer-release.json', receipt)
    print('Relay verified. Review and copy receipt.publicConfig to public/multiplayer-config.json, then release the frontend through Core.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
