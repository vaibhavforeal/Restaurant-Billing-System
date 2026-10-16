# Lower-cost Azure hosting investigation — 2026-10-13

The user declined the approximately USD 70/month D2als_v7 option and requested cheaper alternatives. No hosting resources have been provisioned.

## Best current candidate

Central India `Standard_B2pls_v2`: Arm64, 2 vCPUs, 4GB RAM, burstable CPU. The subscription's SKU inventory lists it without restrictions, but its Standard Bpsv2 quota is zero. Request at least 2 family vCPUs before provisioning. Quota approval and real allocation are not guaranteed.

Azure Retail Prices API, consumption/Linux, checked on October 13:

| Component | Rate | Estimate at 730 hours/month |
| --- | --- | --- |
| B2pls_v2 compute, Central India | USD 0.0224/hour | USD 16.35 |
| E6 LRS Standard SSD, 64GB | USD 5.28/month | USD 5.28 |
| Standard IPv4 public IP | USD 0.005/hour | USD 3.65 |
| Total baseline | | **USD 25.28/month** |

Tax, disk operations, outgoing traffic, external object storage, email, domain, and off-server backup storage are additional. These public retail estimates do not account for subscription discounts, credits, regional taxes, or actual month length. VM allocation remains a separate check from SKU inventory.

East US offers the same ARM size at USD 0.0336/hour, approximately USD 33/month including its USD 4.80/month 64GB SSD and the same public-IP estimate, also requiring Bpsv2 quota. West US 2 and Central India inventory returned the ARM candidate; checked North Europe returned no low-cost candidates. Earlier checks found B2s unavailable/restricted in East US, Central US, East US 2 and South Central US. Do not use the USD 0.0428/hour Cloud Services product price for the ordinary East US VM; the correct Virtual Machines product is USD 0.0336/hour.

## ARM compatibility evidence

Remote Docker manifests for Node 24 bookworm-slim, PostgreSQL 17 bookworm, Nginx 1.28 alpine and Caddy 2 alpine all include Linux Arm64. The installed Argon2 package includes Linux Arm64 prebuilt binaries. Azure validated the Ubuntu 24.04 server-arm64 image. The existing cloud runtime uses PostgreSQL and excludes outlet SQLite/Electron.

This evidence supports trying ARM; it does not prove the complete images build, Argon2 loads, migrations run or the app works on ARM. Run those checks on the selected architecture before customer onboarding. Burstable CPU suits an initial low-traffic staging service; sustained workload and CPU-credit consumption need measurement.

The Azure provisioning script now accepts `-Architecture Arm64`; it selects the Arm64 Ubuntu image. For this candidate use `-Location centralindia -VmSize Standard_B2pls_v2 -Architecture Arm64`, only after quota approval and the user's hosting choice. Keep migration credentials separate from API runtime as documented in cloud-deployment.md.

## Quota request attempt

The user authorized pursuing this option. Microsoft.Quota registration was initiated, and its API confirmed the `standardBpsv2Family` limit is zero in Central India. A request to raise it to 2 was rejected with `MFARequired` (HTTP 412). No quota request was accepted and no VM was created. A fresh user-completed MFA sign-in is needed before retrying; if the account has no MFA, the Azure tenant administrator must enable it through the normal account process.

After the user completed MFA setup, the first retry still returned MFARequired. Azure then reported AADSTS50132 for the cached session (invalid/expired session after account changes). The old pending device login was cancelled and a fresh device login with the Azure management scope was started. User completion of that fresh login is pending. No quota increase has been accepted.
