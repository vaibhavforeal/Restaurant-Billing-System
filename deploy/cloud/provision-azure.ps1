[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SubscriptionId,
  [Parameter(Mandatory)][string]$VmSize,
  [Parameter(Mandatory)][string]$SshPublicKeyPath,
  [Parameter(Mandatory)][string]$SshSourceCidr,
  [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{2,61}[a-z0-9]$')][string]$DnsLabel,
  [string]$Location = 'eastus',
  [ValidateSet('x64', 'Arm64')][string]$Architecture = 'x64',
  [string]$ResourceGroup = 'rg-forkflow-hosting',
  [string]$VmName = 'forkflow-cloud'
)
$ErrorActionPreference = 'Stop'
$cloudInitPath = Join-Path $PSScriptRoot 'azure-cloud-init.yml'
$imageUrn = if ($Architecture -eq 'Arm64') { 'Canonical:ubuntu-24_04-lts:server-arm64:latest' } else { 'Canonical:ubuntu-24_04-lts:server:latest' }
if (!(Test-Path -LiteralPath $SshPublicKeyPath -PathType Leaf)) { throw 'SSH public key file is missing' }
$publicKey = (Get-Content -LiteralPath $SshPublicKeyPath -Raw).Trim()
if ($publicKey -notmatch '^ssh-(ed25519|rsa) ') { throw 'Expected an OpenSSH public key, never a private key' }
if ($SshSourceCidr -notmatch '^\d{1,3}(\.\d{1,3}){3}/32$') { throw 'SSH must be restricted to one IPv4 address (/32)' }

function Invoke-Azure([string[]]$TaskArguments) {
  & az @TaskArguments --subscription $SubscriptionId --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw ('Azure command failed: ' + ($TaskArguments[0..1] -join ' ')) }
}

# Execute only after the VM size and its monthly cost have been accepted.
# This script creates billable Azure resources and does not delete any on failure.
Invoke-Azure -TaskArguments @('group', 'create', '--name', $ResourceGroup, '--location', $Location, '--tags', 'app=forkflow', 'environment=staging', '--output', 'none')
Invoke-Azure -TaskArguments @('network', 'vnet', 'create', '--resource-group', $ResourceGroup, '--name', 'forkflow-vnet', '--address-prefixes', '10.42.0.0/16', '--subnet-name', 'hosting', '--subnet-prefixes', '10.42.1.0/24', '--output', 'none')
Invoke-Azure -TaskArguments @('network', 'nsg', 'create', '--resource-group', $ResourceGroup, '--name', 'forkflow-nsg', '--output', 'none')
Invoke-Azure -TaskArguments @('network', 'nsg', 'rule', 'create', '--resource-group', $ResourceGroup, '--nsg-name', 'forkflow-nsg', '--name', 'ssh-current-computer', '--priority', '100', '--source-address-prefixes', $SshSourceCidr, '--destination-port-ranges', '22', '--access', 'Allow', '--protocol', 'Tcp', '--output', 'none')
Invoke-Azure -TaskArguments @('network', 'nsg', 'rule', 'create', '--resource-group', $ResourceGroup, '--nsg-name', 'forkflow-nsg', '--name', 'web', '--priority', '110', '--source-address-prefixes', 'Internet', '--destination-port-ranges', '80', '443', '--access', 'Allow', '--protocol', 'Tcp', '--output', 'none')
Invoke-Azure -TaskArguments @('network', 'public-ip', 'create', '--resource-group', $ResourceGroup, '--name', 'forkflow-public-ip', '--sku', 'Standard', '--allocation-method', 'Static', '--dns-name', $DnsLabel, '--output', 'none')
Invoke-Azure -TaskArguments @('network', 'nic', 'create', '--resource-group', $ResourceGroup, '--name', 'forkflow-nic', '--vnet-name', 'forkflow-vnet', '--subnet', 'hosting', '--network-security-group', 'forkflow-nsg', '--public-ip-address', 'forkflow-public-ip', '--output', 'none')
Invoke-Azure -TaskArguments @('vm', 'create', '--resource-group', $ResourceGroup, '--name', $VmName, '--nics', 'forkflow-nic', '--image', $imageUrn, '--size', $VmSize, '--admin-username', 'forkflow', '--ssh-key-values', $SshPublicKeyPath, '--authentication-type', 'ssh', '--os-disk-size-gb', '64', '--storage-sku', 'StandardSSD_LRS', '--custom-data', $cloudInitPath, '--tags', 'app=forkflow', 'environment=staging', '--output', 'json')
Invoke-Azure -TaskArguments @('network', 'public-ip', 'show', '--resource-group', $ResourceGroup, '--name', 'forkflow-public-ip', '--query', '{ip:ipAddress,hostname:dnsSettings.fqdn}', '--output', 'json')
