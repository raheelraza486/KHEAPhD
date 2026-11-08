# One-click deployment to AWS (#135)

The backend of the canvas's **Deploy to AWS**: it deploys the Step Functions
workflow of a chain, exactly as the download of `/api/composition/workflow`
holds it, into the site's own AWS account, and runs it on an invoice.
Admins only. The interface follows *一键部署接口约定（草案）* (Guoqiang Chen,
27 October 2026).

| Route | What it does |
|---|---|
| `POST /api/workflows/deployments` | Generates the workflow, checks the secrets, packages it to S3 and starts the CloudFormation stack `bp-<name>`; 202 |
| `GET /api/workflows/deployments/{id}` | The stack's progress, events, state machine, console link and functions |
| `DELETE /api/workflows/deployments/{id}` | Deletes the stack (functions, roles, state machine); 202 |
| `POST /api/workflows/deployments/{id}/executions` | Starts a trial run: multipart `invoice` (PDF, image or XML) and optional `options`; 202 |
| `GET /api/workflows/executions/{execution ARN, URL-encoded}` | The run's status, each state of the definition by name, the first error and a one-line result |

Errors are `{ error, requestId, details? }`: 400 body or parameters
(`missing_parameter`, `unknown_parameter`, `invalid_parameter`,
`server_parameter`), 401/403, 403 `recipient_not_allowed`, 404, 409
(`in_progress`, or `delete_first` after a failed first creation), 412
`missing_secret` with the command that creates it, 422 the generator's issues,
429 `retry_after_seconds` (trial runs), 502 `aws_error` with AWS's own message,
503 not configured (`not_configured`, `server_setting_missing`).

As on the composed routes, the three that change something (`POST`, `DELETE`
and the trial run) answer only a same-origin request (`isSameOrigin`; 403
otherwise). A trial run really sends the invoice, so each admin may start five
a minute.

## Parameters

The page sends only what a person chooses (`MailgunTo`, a subject). The server
fills in, from its own settings, `MailgunDomainName` (`MAILGUN_DOMAIN`),
`MailgunFrom` (`MAILGUN_FROM`, else `postmaster@<domain>`) and
`B2BrouterAccount` (`B2BROUTER_ACCOUNT_ID`), which a request may override, and
the hidden `UpbrainsFlowId` from `UPBRAINS_WEBHOOK_URL`
(`…/webhooks/<flowId>`, with or without `/sync`), which a request may not send.
Everything else takes the template's default. A value may not contain quotes,
backslashes or control characters, since it is placed in a JSON string. Values
are never logged or returned.

A recipient (`MailgunTo`) must be the admin's own account address or one listed
in `MAILGUN_ALLOWED_RECIPIENTS`, the rule `/api/composed/peppol-invoice` keeps
for email, since every trial run sends from the group's Mailgun domain.

## How a deployment runs

1. Each function folder is zipped (Unix mode 0644, fixed date), and the
   definition and the template are uploaded to `WORKFLOW_ARTIFACT_BUCKET` under
   `bp-<name>/`, each key carrying a digest of its content; `CodeUri` and
   `DefinitionUri` point at them, as `aws cloudformation package` does.
2. A change set (`bp-deploy-<time>`, CREATE or UPDATE, `CAPABILITY_IAM` and
   `CAPABILITY_AUTO_EXPAND` for the SAM transform) is created, and executed
   once CloudFormation has prepared it, within the request when it can (about
   10 seconds), else by the next status poll. The same code and parameters
   again are reported as succeeded without a change.
3. The stack takes one to three minutes; `GET` reads it back from
   CloudFormation each time, so nothing is kept on the server.

The stack name comes from the chain, so deploying a chain that was deployed
from CloudShell (`bp-upbrains-amittransform-ess-mailgun`, `…-b2brouter`)
updates that stack, and the page's parameters replace the ones it had.

## Setting it up (once, by an admin of the AWS account)

The bucket and the three secrets below were created when #136 was deployed
from CloudShell, so steps 1 and 2 only check that they are there.

1. **Bucket**: `bp-sfn-artifacts-803964123922` in ap-southeast-2, public access
   blocked. The packaged files are only read at deployment time, so a
   lifecycle rule may expire them after 90 days.
2. **Secrets** the functions read (the site keeps its own copies as ECS
   secrets; these are separate): `bp-builder/ess` (the API key),
   `bp-builder/mailgun` (`api:<key>`) and `bp-builder/b2brouter` (the API key).
   A missing one is created with:
   ```bash
   read -rs VALUE && aws secretsmanager create-secret --name bp-builder/<name> --secret-string "$VALUE"; unset VALUE
   ```
   A chain with another provider names its secret, and this command, in the
   412 answer.
3. **Service settings**: `WORKFLOW_ARTIFACT_BUCKET=bp-sfn-artifacts-803964123922`
   on the ECS service (`AWS_REGION` defaults to ap-southeast-2). The service
   already has `MAILGUN_DOMAIN`, `B2BROUTER_ACCOUNT_ID` and
   `UPBRAINS_WEBHOOK_URL`. Without `MAILGUN_FROM` the sender is
   `postmaster@<domain>`; the CloudShell deployments used
   `CS9-5 Business API Ecosystem <postmaster@<domain>>`, which `MAILGUN_FROM`
   can set. `scripts/deploy.sh` changes only the image, so it keeps these.
4. **Task role**: the service has none, so the server has no AWS permissions.
   The site is an ECS Express service, so the role is set on the service
   (`aws ecs update-express-gateway-service --service-arn <service> --task-role-arn <role>`),
   not on a task definition; check that it is still set after the next
   `scripts/deploy.sh`. The role gets the policy below, with which
   CloudFormation creates the functions, roles and state machine, scoped to
   `bp-*` stacks, `bp*` functions and `bp-*` roles.

The policy lists what CloudFormation called in CloudTrail while the two #136
stacks were deployed (checked with `aws iam simulate-custom-policy`), plus what
the resource types' handlers list for update and delete (`aws cloudformation
describe-type`), and passes IAM Access Analyzer's `validate-policy`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Stacks",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet", "cloudformation:ListChangeSets", "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents", "cloudformation:DeleteStack", "cloudformation:GetTemplateSummary"
      ],
      "Resource": "arn:aws:cloudformation:ap-southeast-2:803964123922:stack/bp-*/*"
    },
    {
      "Sid": "SamTransform",
      "Effect": "Allow",
      "Action": "cloudformation:CreateChangeSet",
      "Resource": "arn:aws:cloudformation:ap-southeast-2:aws:transform/Serverless-2016-10-31"
    },
    {
      "Sid": "Artifacts",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::bp-sfn-artifacts-803964123922/*"
    },
    {
      "Sid": "Functions",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:TagResource", "lambda:UntagResource",
        "lambda:ListTags", "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionRecursionConfig",
        "lambda:GetRuntimeManagementConfig", "lambda:GetFunctionScalingConfig"
      ],
      "Resource": "arn:aws:lambda:ap-southeast-2:803964123922:function:bp*"
    },
    {
      "Sid": "StateMachines",
      "Effect": "Allow",
      "Action": [
        "states:CreateStateMachine", "states:UpdateStateMachine", "states:DeleteStateMachine", "states:DescribeStateMachine",
        "states:TagResource", "states:UntagResource", "states:ListTagsForResource",
        "states:StartExecution", "states:DescribeExecution", "states:GetExecutionHistory", "states:DescribeStateMachineForExecution"
      ],
      "Resource": [
        "arn:aws:states:ap-southeast-2:803964123922:stateMachine:*",
        "arn:aws:states:ap-southeast-2:803964123922:execution:*:*"
      ]
    },
    {
      "Sid": "WorkflowRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole", "iam:UntagRole",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:UpdateAssumeRolePolicy"
      ],
      "Resource": "arn:aws:iam::803964123922:role/bp-*"
    },
    {
      "Sid": "PassWorkflowRoles",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::803964123922:role/bp-*",
      "Condition": { "StringEquals": { "iam:PassedToService": ["lambda.amazonaws.com", "states.amazonaws.com"] } }
    },
    {
      "Sid": "SecretsExist",
      "Effect": "Allow",
      "Action": "secretsmanager:DescribeSecret",
      "Resource": "arn:aws:secretsmanager:ap-southeast-2:803964123922:secret:bp-builder/*"
    },
    {
      "Sid": "AccountReads",
      "Effect": "Allow",
      "Action": ["iam:GetAccountSummary", "lambda:GetAccountSettings", "ec2:DescribeNetworkInterfaces"],
      "Resource": "*"
    }
  ]
}
```

The server never reads a secret's value (`DescribeSecret` only): the functions
read them at run time with their own roles, which the template grants.

**Known risk.** The role can create `bp-*` roles, put any inline policy on
them and pass them to Lambda, so whoever can act as the server could build a
function with wide permissions. The routes are admin only; a permissions
boundary on the `bp-*` roles would close this, and is not set up yet.

## Code

- `deploy.ts`: parameters, packaging, starting, status and deleting.
- `executions.ts`: the trial run's input (as `make_input.py` writes it) and
  each state's status from the execution history.
- `aws.ts`: the AWS SDK calls; `types.ts` the interface the rest uses, so
  `tests/workflow-deploy` runs against an in-memory fake (`fake-aws.ts`).

## Invoice recovery and stored PDF inputs (31 October)

The site accepts PDFs up to 4 MB. Inputs that fit within 250,000 bytes still
run inline for backward compatibility. A larger PDF is uploaded encrypted
(SSE-S3) under `<stack>/inputs/<random UUID>.pdf` in the existing private artifact
bucket. Only `{document:{s3:{bucket,key}},options}` enters the execution history.
`WorkflowInputBucket` is server-supplied, cannot be redirected by a request,
and is passed as a non-secret template parameter. No public or signed URL is
created. The first binary-reading function has only `s3:GetObject` on its own
stack's inputs prefix and validates the bucket, prefix, PDF header and size.
Later functions receive extracted data and have no input-bucket permissions.

The SAM parameter defaults to empty, preserving inline-only CloudShell use.
`StoredInputVersion=1` and `InputStorageBucket` outputs advertise support;
an older deployment refuses large input before uploading or calling providers
and asks for redeployment. Updating the website alone does not update Lambda
code in an already deployed workflow. Use **Deploy again** after this PR is
merged and the site is deployed. No cloud resources are changed by this PR.

Stored PDFs follow the artifact bucket's configured retention. Stack deletion
does not remove them. Retain inputs for the required execution/redrive window
and set expiration on each `<stack>/inputs/` prefix; never make the bucket
public or grant functions access to every workflow's documents. Do not log
invoice contents or use a bearer download URL as the execution input.

Failures at `Validation failed` now include up to five bounded validator
findings (500 characters total) taken from the failed execution's report.
Raw history inputs/outputs are discarded, and ordinary status reads still
request no execution data. A split amount-only extraction fragment is joined
only to a unique matching adjacent detail on the same explicit page, with
the original tax rate and exact quantity × price checks retained.

Sandbox replay replacements (`invoiceId`, `issueDate`, `dueDate`) are explicit.
An old due date is never silently moved when the issue date changes. Seller
ABNs remain source identities; the page no longer defaults a different
invoice's seller to the demo company. Repeated-number, closed-year and missing
Peppol-connection errors have distinct remedies. Account connection changes
still belong in B2Brouter; no code change can register a company's Peppol
connection or make an unsupported/ambiguous source invoice valid.

The new requirement to save a generated selected chain into the Repository
is outside this bug-fix change.
