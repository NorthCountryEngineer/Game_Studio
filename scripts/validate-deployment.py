"""Offline structural/security checks for packaged Game Studio infrastructure.

This complements (and never replaces) cfn-lint, cfn-guard and AWS account-aware
pre-deployment validation. It makes no AWS or network requests.
"""
import json
from pathlib import Path

from core_bundle import validate_bundle

ROOT = Path(__file__).resolve().parents[1]


def check_template(path):
    template = json.loads(path.read_text())
    assert path.stat().st_size <= 51200, 'Template exceeds CloudFormation inline size.'
    assert template['Metadata']['AWSToolsMetrics']['AWSAgentToolkit'] == 'aws-cloudformation@3'
    resources = template['Resources']
    names = set(resources) | set(template.get('Parameters', {}))
    pseudo = {'AWS::AccountId', 'AWS::NotificationARNs', 'AWS::NoValue', 'AWS::Partition', 'AWS::Region', 'AWS::StackId', 'AWS::StackName', 'AWS::URLSuffix'}

    def walk(value):
        if isinstance(value, dict):
            if set(value) == {'Ref'}:
                assert value['Ref'] in names | pseudo, f"Undefined Ref {value['Ref']}"
            if 'Fn::GetAtt' in value:
                assert value['Fn::GetAtt'][0] in resources
            for child in value.values(): walk(child)
        elif isinstance(value, list):
            for child in value: walk(child)
    walk(template)
    for name, resource in resources.items():
        assert resource['Metadata']['com.aws.cloudformation.Context'].get('why'), f'Missing context: {name}'
        if resource['Type'] in ['AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::Amplify::App', 'AWS::Amplify::Branch']:
            assert resource.get('DeletionPolicy') == resource.get('UpdateReplacePolicy') == 'Retain'
        if resource['Type'] == 'AWS::DynamoDB::Table':
            assert resource['Properties']['BillingMode'] == 'PAY_PER_REQUEST'
            assert resource['Properties']['SSESpecification']['SSEEnabled'] is True
        if resource['Type'] == 'AWS::S3::Bucket':
            props = resource['Properties']
            assert all(props['PublicAccessBlockConfiguration'].get(key) is True for key in ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'])
            assert props['BucketEncryption']['ServerSideEncryptionConfiguration']
            assert props['VersioningConfiguration']['Status'] == 'Enabled'
        if resource['Type'] == 'AWS::Lambda::Permission':
            assert resource['Properties']['SourceAccount'] == {'Ref': 'AWS::AccountId'}
            assert resource['Properties']['SourceArn']
    assert 'axolotl.news' not in path.read_text()
    assert '/axolotl-news/' not in path.read_text()
    return template


def main():
    backend = check_template(ROOT / 'infra/aws/game-studio.template.json')
    frontend = check_template(ROOT / 'infra/aws/frontend.template.json')
    env = backend['Resources']['ApiFunction']['Properties']['Environment']['Variables']
    assert all(key in env for key in ['CORE_ISSUER', 'CORE_ORGANIZATION_ID', 'CORE_SERVICE_ID', 'CORE_CREDENTIALS_PARAMETER', 'PRIVATE_TABLE', 'PUBLIC_TABLE', 'ASSISTANT_TABLE', 'GAME_DRAFT_TABLE', 'GAME_PUBLIC_TABLE', 'GAME_STUDIO_CONFIG_JSON'])
    assert backend['Resources']['HttpApi']['Properties']['CorsConfiguration']['AllowOrigins'] == {'Ref': 'AllowedOrigins'}
    assert frontend['Resources']['FrontendBranch']['Properties']['EnableAutoBuild'] is False
    assert (ROOT / 'backend/nce_api/agent-framework.json').read_bytes() == (ROOT / 'config/agent-framework.json').read_bytes(), 'Core and external registry defaults differ.'
    package = json.loads((ROOT / 'nce/marketplace.json').read_text())
    permissions = {p['codename'] for p in package['manifest']['permissions']}
    assert permissions == {'games-play', 'games-create', 'games-publish', 'games-manage', 'agents-manage', 'accounts-manage'}
    assert package['slug'] == 'game-studio'
    assert package['manifest']['external_runtime'] == 'aws-amplify'
    validate_bundle(ROOT)
    print('Offline structure/security invariants passed. Formal cfn-lint/cfn-guard and account-aware checks are separate and have not run.')


if __name__ == '__main__': main()
