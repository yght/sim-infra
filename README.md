# sim-infra

Terraform and Lambda for the multi-carrier SIM platform on AWS. Related domain sample:
[sim-platform](https://github.com/yght/sim-platform).

*Rebuild note: this is a cleaned-up version of infrastructure I built between
2019 and 2021. Account numbers, bucket names, carrier SFTP details and the
real CIDR plan are gone. The module structure and the operational decisions
are the originals. I can walk through the live setup on a call.*

## What I want to demonstrate

I want to show how I connect cloud infrastructure decisions to service reliability, operating cost and billing correctness.

- **AWS infrastructure:** reusable Terraform modules, network boundaries and environment configuration.
- **Data processing:** normalising carrier usage formats and units before aggregation.
- **Operations:** least-privilege access and alarms for missing activity as well as explicit failures.
- **Customer impact:** protecting usage records and making billing discrepancies easier to investigate.

**Start here:** [network module](terraform/modules/network/main.tf), [usage parsers](lambda/usage-ingest/src/parsers.js), and [ingestion handler](lambda/usage-ingest/src/handler.js).

**Scope:** infrastructure and ingestion samples related to the SIM platform, with deployment-specific values removed. The public SIM repository does not include the application services required for a complete deployment.

**Known correctness gap:** the handler writes each batch to the same daily totals object after deduplication. Replaying a completed file can overwrite those totals with an empty result; multiple files and concurrent processing also need safe aggregation and coordinated deduplication. This must be addressed before using the handler for billing.

## What this runs

Four Fargate services behind one ALB, a Postgres instance the tasks can reach
and nothing else can, and a nightly batch job that turns carrier usage files
into billable records.

```
                 ALB (public subnets)
                      │
        ┌─────────────┼─────────────┬──────────────┐
        ▼             ▼             ▼              ▼
     gateway     sim-service   carrier-service   worker      (private subnets)
                                                   │
                                                   ▼
                                            RDS + DynamoDB    (isolated subnets)

  carrier SFTP ──▶ S3 landing ──▶ Lambda ──▶ S3 rated
                                    │
                                    └──▶ DLQ ──▶ alarm ──▶ pager
```

Three subnet tiers. The isolated one has a route table with no default route
in it at all — the absence *is* the control. A task that gets compromised has
no path to the internet from the database tier because there isn't one to
misconfigure.

## The bits worth looking at

**`lambda/usage-ingest/src/parsers.js`** is where the real work is. Three
carriers, three file formats, three sets of lies in the documentation. Bell
send pipe-delimited with timestamps in Eastern local and volumes in
kilobytes; Vodafone send CSV in UTC and bytes; AT&T send JSON lines in
megabytes as decimal strings. Getting the units wrong overbills someone by a
factor of a thousand, so there's a test asserting that one mebibyte of usage
reports identically through all three parsers.

**`lambda/usage-ingest/src/usage.js`** dedupes and rolls up. Dedupe is keyed
on `(carrier, recordId)` — not `recordId` alone, because Bell and AT&T have
both used plain integers and have collided.

**`terraform/modules/usage-pipeline/iam.tf`** — the Lambda can read
`incoming/*` and write `rated/*`, and that's it. No delete anywhere. A bug
must not be able to overwrite a carrier's original file, because that file is
the evidence in a billing dispute.

**`terraform/modules/network/main.tf`** — the three tiers, and the S3 and
DynamoDB gateway endpoints. Those endpoints are free and they took the
nightly ingest off the NAT, which had been most of the NAT bill.

## Environments

`envs/dev` and `envs/prod` use the same modules at the same provider version.
What differs is only what costs money or what dev genuinely doesn't need:

| | dev | prod |
|---|---|---|
| AZs | 2 | 3 |
| NAT gateways | 1 shared | 1 per AZ |
| VPC flow logs | off | on, REJECT only |
| Log retention | 14 days | 90 days |
| DLQ alarm goes to | Slack | Slack + pager |

Dev is not a miniature production and doesn't pretend to be. It's the same
structure with the expensive bits turned down, so a module change gets
exercised before it reaches anything that matters.

## The alarm that matters most

Not the error alarm. The silence alarm.

A carrier that quietly stops uploading looks exactly like a quiet night — no
errors, no DLQ messages, no invocations. We went four days without Vodafone
usage before anyone noticed, and four days of unbilled data is real money.

So `no_invocations` fires when the ingest hasn't run in 24 hours, with
`treat_missing_data = "breaching"`. That last setting is the whole point: if
the metric isn't reporting, that's the condition we're worried about, not a
reason to stay quiet.

## Running the checks

```bash
cd lambda/usage-ingest && npm install && npm test    # 52 tests

cd terraform && terraform fmt -check -recursive
cd terraform/envs/dev && terraform init -backend=false && terraform validate
```

The Terraform validates against AWS provider 3.x, which is what it was written
for. It won't validate against provider 4 or later — the inline `versioning`
and `lifecycle_rule` blocks on `aws_s3_bucket` were split into separate
resources in provider 4, and porting that is a real piece of work rather than
a search and replace.

No credentials here. No account ids, no real bucket names, and the backend
block points at a state bucket that doesn't exist.

## What I'd change

The S3 bucket resources are pinned to provider 3.x and that's a growing debt.
The port is mechanical but wide — every bucket gains four or five satellite
resources.

Task definitions take `image` as a plain string, so a deploy is `terraform
apply` with a new tag. That couples application deploys to infrastructure
state and it shouldn't; the image tag belongs in a deployment tool, with
Terraform ignoring changes to it.

There are no automated policy checks. Everything here was reviewed by a human
reading a plan, which caught most things and missed a public bucket ACL once.
`tfsec` or Checkov in CI would have caught that in seconds.

The dedupe table stores the whole key set as one DynamoDB item per
carrier-day. That's fine at current volumes and falls over at 400KB, which is
roughly 10,000 records in a day. It's closer than I'd like.
