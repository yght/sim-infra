# 1. Three subnet tiers, and the isolated one has no route

Date: 2019-09-24
Status: Accepted

## Context

The usual two-tier layout is public for load balancers and private for
everything else, with the private subnets routing to the internet through a
NAT gateway.

That gives the database tier an outbound path to the internet. Nothing needs
it. Postgres does not phone home. But the route exists, so anything that ends
up running in that subnet — a compromised task, a debug container someone
left behind, a misconfigured service — can reach the internet and take data
with it.

## Decision

Three tiers:

* **public** — the ALB, and nothing else
* **private** — Fargate tasks, outbound via NAT
* **isolated** — RDS and ElastiCache, on a route table with no default route

The isolated route table is created empty and stays empty. Reaching AWS
services from there is done through VPC endpoints, which is a separate,
explicit grant per service.

## Consequences

Good:

* Exfiltration from the data tier needs a route that does not exist. It is not
  a rule someone can loosen in a hurry during an incident, which is exactly
  when rules get loosened.
* The S3 and DynamoDB gateway endpoints are free and took the nightly usage
  ingest off the NAT entirely. That was most of the NAT bill.
* It is obvious from `terraform plan` which tier a new resource lands in.

Bad:

* Anything genuinely needing outbound access from the isolated tier requires a
  new interface endpoint, at roughly $8 a month each plus data. We have four.
* Bootstrapping is more awkward — an RDS instance that needs an extension from
  the internet cannot get it, and the answer is a task in the private tier
  doing it over the VPC.
* The CIDR maths needs three blocks per AZ instead of two, so the VPC has to
  be sized with that in mind from the start. Resizing later is not a thing.
