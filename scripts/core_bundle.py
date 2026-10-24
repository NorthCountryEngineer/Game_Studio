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
TEMPLATE_SOURCE = '588d02b5eb4a6a91b0422f28463ebb1bac514194'  # pragma: allowlist secret
TEMPLATE_PATH = 'deployment/aws-platform/platform.template.json'
# Public SHA256 of reviewed Core template bytes, not a credential.
TEMPLATE_SHA256 = '05ec54a6a50ab4d58e19a99722f300f5bf9dea20294543665815ba6c028dc72b'  # pragma: allowlist secret
TEMPLATE_BYTES = 51175
# Public digests of the locally apply-verified patch and all post-patch hashes.
PATCH_SHA256 = '1aa176ab82ec6f5362b84d9d7d258040bb30856a7b5593974fa112efae5cd172'  # pragma: allowlist secret
FILES_SHA256 = 'f4539949d4dffebb33f264350dd962fbc200a858a4f3ff81653a9801d12062e1'  # pragma: allowlist secret


def require(value, message):
    if not value:
        raise ValueError(message)


def full_template_section(patch):
    sections = re.split(rb'(?m)(?=^diff --git )', patch)
    prefix = ('diff --git a/' + TEMPLATE_PATH + ' b/' + TEMPLATE_PATH + '\n').encode()
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
    raw = full_template_section(patch)
    require(len(raw) == TEMPLATE_BYTES == metadata['checks']['onboarding_template_bytes'], 'The bundled template byte count changed.')
    require(hashlib.sha256(raw).hexdigest() == TEMPLATE_SHA256 == metadata['files'][TEMPLATE_PATH], 'The bundled template is not the exact reviewed source.')
    overrides = metadata.get('per_file_overrides')
    require(isinstance(overrides, list) and len(overrides) == 1, 'The bundle must identify its one template-only override.')
    override = overrides[0]
    require(override.get('repository') == 'NorthCountryEngineer/NCE_Core' and override.get('commit') == TEMPLATE_SOURCE
            and override.get('path') == TEMPLATE_PATH and override.get('sha256') == TEMPLATE_SHA256
            and override.get('pull_request') == 'https://github.com/NorthCountryEngineer/NCE_Core/pull/9', 'Template override provenance differs from reviewed Core source.')
    validate_template_scope(json.loads(raw))
    return {'files': len(paths), 'templateBytes': len(raw), 'templateSource': TEMPLATE_SOURCE}


if __name__ == '__main__':
    print(validate_bundle(Path(__file__).resolve().parents[1]))
