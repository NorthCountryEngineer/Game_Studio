"""Offline integrity checks for the historical, explicitly versioned Core patch.

Never apply a patch or fetch Core source here. The complete application of the
bundle and every post-patch file hash are reviewed against its stated Core base.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

BASELINE = 'c27e6a03ff47adf4acc8e670ec2f240127744172'  # pragma: allowlist secret
RECIPE_SOURCE = '52d8ad1c3846a9151b482c499576e5fe964290ec'  # pragma: allowlist secret
TEMPLATE_SOURCE = '1e7e89d3caaafc182ab97268c87cb39b5a3a58ea'  # pragma: allowlist secret
TEMPLATE_PATH = 'deployment/aws-platform/platform.template.json'
# Public SHA256 of reviewed Core template bytes, not a credential.
TEMPLATE_SHA256 = '575eed28292790ae55ee68145ef90c20a71df467585a25dfe44d56e6729b51a9'  # pragma: allowlist secret
TEMPLATE_BYTES = 51129
GAME_TEMPLATE_PATH = 'deployment/aws-apps/game-studio.template.json'
GAME_TEMPLATE_SHA256 = '1870dc194150f3383228733f971e16a6629f5cfa45befb8ec65c4fbaf665db57'  # pragma: allowlist secret
GAME_TEMPLATE_BYTES = 30349
CONTEXT_PATH = 'deployment/aws-platform/README.md'
CONTEXT_SHA256 = 'e31788fdbcb5306bce78ca1411e1adb19ebe1ce2d9f2c9f43bd4040a441af6ec'  # pragma: allowlist secret
CONTEXT_BYTES = 13139
# Public digests of the locally apply-verified patch and all post-patch hashes.
PATCH_SHA256 = 'f0ba4c0c87b0dd6a4e555dffc48f8a4a08eafa533d5242917202b0f7cda47252'  # pragma: allowlist secret
FILES_SHA256 = 'f5f4562bfbe84b74e0eb75113a3de73a5f171a31722662201969b7ab9697c1e9'  # pragma: allowlist secret


def require(value, message):
    if not value:
        raise ValueError(message)


def full_template_section(patch, path=TEMPLATE_PATH):
    sections = re.split(rb'(?m)(?=^diff --git )', patch)
    prefix = ('diff --git a/' + path + ' b/' + path + '\n').encode()
    matches = [section for section in sections if section.startswith(prefix)]
    require(len(matches) == 1, 'The bundle needs exactly one full platform template section.')
    section = matches[0]
    hunks = list(re.finditer(rb'(?m)^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,([0-9]+))? @@[^\n]*\n', section))
    require(len(hunks) == 1 and hunks[0][1] == b'1', 'The reviewed template must be represented by one complete target hunk.')
    expected_lines = int(hunks[0][2] or b'1')
    target = []
    for line in section[hunks[0].end():].splitlines(keepends=True):
        if line.startswith((b'+', b' ')):
            target.append(line[1:])
        else:
            require(line.startswith(b'-'), 'Unexpected template patch content.')
    require(len(target) == expected_lines, 'The platform template target is incomplete.')
    return b''.join(target)


def validate_template_scope(template):
    resources = template['Resources']
    entries = resources['CloudFormationRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
    matches = [entry for entry in entries if entry.get('Sid') == 'TagHttpApiForCloudFormation']
    require(matches == [{
        'Sid': 'TagHttpApiForCloudFormation', 'Effect': 'Allow', 'Action': ['apigateway:POST'],
        'Resource': {'Fn::Sub': 'arn:${AWS::Partition}:apigateway:${AWS::Region}::/tags/arn%3A${AWS::Partition}%3Aapigateway%3A${AWS::Region}%3A%3A%2Fv2%2Fapis%2F*'},
        'Condition': {'StringEquals': {'aws:RequestedRegion': {'Ref': 'AWS::Region'}, 'aws:RequestTag/nce:platform-prefix': {'Ref': 'Prefix'}}},
    }], 'The bundled HTTP API tagging grant escaped its reviewed scope.')
    children = [entry for entry in entries if entry.get('Sid') == 'CreateTaggedHttpApiChildren']
    require(children == [{
        'Sid': 'CreateTaggedHttpApiChildren', 'Effect': 'Allow', 'Action': ['apigateway:POST'],
        'Resource': [{'Fn::Sub': 'arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis/*/' + name}
                     for name in ['integrations', 'routes', 'stages']],
        'Condition': {'StringEquals': {'aws:ResourceTag/nce:platform-prefix': {'Ref': 'Prefix'}, 'aws:RequestedRegion': {'Ref': 'AWS::Region'}}},
    }], 'The bundled HTTP API child-creation grant escaped its reviewed scope.')
    stage_tags = [entry for entry in entries if entry.get('Sid') == 'TagHttpApiStages']
    require(stage_tags == [{
        'Sid': 'TagHttpApiStages', 'Effect': 'Allow', 'Action': ['apigateway:TagResource'],
        'Resource': {'Fn::Sub': 'arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis/*/stages'},
        'Condition': {'StringEquals': {'aws:ResourceTag/nce:platform-prefix': {'Ref': 'Prefix'},
                                     'aws:RequestTag/nce:platform-prefix': {'Ref': 'Prefix'},
                                     'aws:RequestedRegion': {'Ref': 'AWS::Region'}}},
    }], 'The bundled HTTP API stage-tagging grant escaped its reviewed scope.')
    api_entries = [entry for entry in entries if any(action.startswith('apigateway:') for action in entry.get('Action', []))]
    require(len(api_entries) == 6 and {entry.get('Sid') for entry in api_entries} == {
        'CreateNamedHttpApi', 'CreateTaggedHttpApiChildren', 'ManageTaggedHttpApi',
        'TagHttpApiStages', 'TagHttpApiForCloudFormation', 'ReadHttpApiTags'}, 'The bundled HTTP API authority gained another grant.')
    for name in ['Runner', 'SourceBuilder']:
        require(resources[name]['Properties']['SourceVersion'] == {'Ref': 'RunnerCommit'}, 'The trusted runner source must remain pinned.')
    require(template['Parameters']['GameStudioModelArns']['Default'] == '', 'Model authority must remain default-empty.')
    create = next(entry for entry in entries if entry.get('Sid') == 'CreateBoundedRoles')
    require(create['Condition']['ArnEquals']['iam:PermissionsBoundary'] == {'Ref': 'AppBoundary'}, 'App roles must retain their boundary.')
    validate_frontend_binding_scope(template)


def validate_frontend_binding_scope(template):
    parameters, resources = template['Parameters'], template['Resources']
    for name, default, pattern in [
        ('GameStudioFrontendAppId', '', '^$|^d[a-z0-9]{1,40}$'),
        ('GameStudioFrontendBranch', 'production', '^[A-Za-z0-9._-]{1,255}$'),
    ]:
        value = parameters[name]
        require(value['Type'] == 'String' and value['Default'] == default and value['AllowedPattern'] == pattern,
                'The frontend binding must default disabled with literal app and branch inputs.')
    require(template['Conditions']['HasBoundGameStudioFrontend'] == {'Fn::Not': [{'Fn::Equals': [{'Ref': 'GameStudioFrontendAppId'}, '']}]},
            'The frontend binding must require an explicit owner-selected app.')
    policy = resources['GameStudioFrontendPublishPolicy']
    require(policy['Type'] == 'AWS::IAM::ManagedPolicy' and policy['Condition'] == 'HasBoundGameStudioFrontend',
            'The frontend binding must remain a separate conditional policy.')
    require(policy['Properties'] == {
        'Roles': [{'Ref': 'RunnerRole'}],
        'PolicyDocument': {'Version': '2012-10-17', 'Statement': [{
            'Effect': 'Allow', 'Action': ['amplify:CreateDeployment', 'amplify:StartDeployment'],
            'Resource': [{'Fn::Sub': 'arn:${AWS::Partition}:amplify:${AWS::Region}:${AWS::AccountId}:apps/${GameStudioFrontendAppId}/branches/${GameStudioFrontendBranch}' + suffix}
                         for suffix in ['', '/deployments/*', '/jobs/*']],
            'Condition': {'StringEquals': {'aws:RequestedRegion': {'Ref': 'AWS::Region'}}},
        }]},
    }, 'The frontend binding escaped its exact runner, app, branch, account, region or two publish actions.')


def validate_game_recipe_scope(template):
    resources = template['Resources']
    properties = {'Action': 'lambda:InvokeFunction', 'FunctionName': {'Ref': 'Function'},
        'Principal': 'apigateway.amazonaws.com', 'SourceAccount': {'Ref': 'AWS::AccountId'},
        'SourceArn': {'Fn::Sub': 'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/$default/$default'}}
    exact = resources['ApiDefaultInvoke']
    require(exact['Type'] == 'AWS::Lambda::Permission' and exact['Condition'] == 'Serverless' and exact['Properties'] == properties,
            'The game recipe default-route invocation permission escaped its reviewed scope.')
    require(resources['ApiInvoke']['Properties'] == {**properties, 'SourceArn': {'Fn::Sub':
        'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*/*/*'}},
        'The game recipe must preserve its legacy permission without replacement.')
    require(resources['ApiDefaultRoute']['Properties']['RouteKey'] == resources['ApiDefaultStage']['Properties']['StageName'] == '$default',
            'The game recipe route and stage must match the exact invocation permission.')
    require({name for name, resource in resources.items() if resource['Type'] == 'AWS::Lambda::Permission'} == {'ApiInvoke', 'ApiDefaultInvoke'},
            'The game recipe gained an unreviewed invocation grant.')


def validate_bundle(root):
    root = Path(root)
    patch = (root / 'nce/core-onboarding.patch').read_bytes()
    metadata = json.loads((root / 'nce/core-patch-baseline.json').read_text())
    require(metadata['baseline'] == BASELINE and metadata['core_change_commit'] == RECIPE_SOURCE, 'Historical recipe provenance changed.')
    require(hashlib.sha256(patch).hexdigest() == metadata['patch_sha256'] == PATCH_SHA256, 'The complete Core patch hash does not match its manifest.')
    headers = re.findall(rb'(?m)^diff --git a/([^\n]+) b/([^\n]+)$', patch)
    paths = []
    for old, new in headers:
        require(old == new, 'Renamed Core patch paths require separate review.')
        path = new.decode('utf-8')
        parsed = PurePosixPath(path)
        require(not parsed.is_absolute() and '..' not in parsed.parts and '.git' not in parsed.parts, 'Unsafe Core patch path.')
        paths.append(path)
    require(len(paths) == len(set(paths)) and set(paths) == set(metadata['files']), 'Core patch paths and full-file hash manifest differ.')
    require(all(re.fullmatch(r'[a-f0-9]{64}', value) for value in metadata['files'].values()), 'Invalid Core file hash.')
    require(hashlib.sha256(json.dumps(metadata['files'], sort_keys=True, separators=(',', ':')).encode()).hexdigest() == FILES_SHA256, 'The complete post-patch manifest differs from its apply-verified source.')
    templates = [(TEMPLATE_PATH, TEMPLATE_SHA256, TEMPLATE_BYTES, 'onboarding_template_bytes'),
                 (GAME_TEMPLATE_PATH, GAME_TEMPLATE_SHA256, GAME_TEMPLATE_BYTES, 'game_recipe_bytes')]
    documents = {}
    for path, sha256, size, check in templates:
        raw = full_template_section(patch, path)
        require(len(raw) == size == metadata['checks'][check], 'The bundled template byte count changed.')
        require(hashlib.sha256(raw).hexdigest() == sha256 == metadata['files'][path], 'The bundled template is not the exact reviewed source.')
        documents[path] = json.loads(raw)
    context = full_template_section(patch, CONTEXT_PATH)
    require(len(context) == CONTEXT_BYTES == metadata['checks']['platform_context_bytes']
            and hashlib.sha256(context).hexdigest() == CONTEXT_SHA256 == metadata['files'][CONTEXT_PATH],
            'The architecture context sidecar is not the exact reviewed source.')
    for resource in documents[TEMPLATE_PATH]['Resources'].values():
        for reference in resource.get('Metadata', {}).get('com.aws.cloudformation.Context', {}).get('ref', []):
            if reference.get('at') == CONTEXT_PATH:
                require(reference['has'].encode() in context, 'A platform architecture context reference is unresolved.')
    overrides = metadata.get('per_file_overrides')
    require(isinstance(overrides, list) and len(overrides) == 3 and all(isinstance(row, dict) and isinstance(row.get('path'), str) for row in overrides),
            'The bundle must identify its two templates and required context override.')
    expected = {path: sha256 for path, sha256, _, _ in templates}
    expected[CONTEXT_PATH] = CONTEXT_SHA256
    require({row.get('path') for row in overrides} == set(expected), 'Template override provenance differs from reviewed Core source.')
    for override in overrides:
        require(override.get('repository') == 'NorthCountryEngineer/NCE_Core' and override.get('commit') == TEMPLATE_SOURCE
                and override.get('sha256') == expected[override['path']]
                and override.get('pull_request') == 'https://github.com/NorthCountryEngineer/NCE_Core/pull/6', 'Template override provenance differs from reviewed Core source.')
    validate_template_scope(documents[TEMPLATE_PATH])
    validate_game_recipe_scope(documents[GAME_TEMPLATE_PATH])
    return {'files': len(paths), 'templateBytes': TEMPLATE_BYTES, 'templateSource': TEMPLATE_SOURCE,
            'gameRecipeBytes': GAME_TEMPLATE_BYTES, 'gameRecipeSource': TEMPLATE_SOURCE, 'contextBytes': CONTEXT_BYTES}


if __name__ == '__main__':
    print(validate_bundle(Path(__file__).resolve().parents[1]))
