# AWS single-host production recovery

## Scope and objectives

This runbook covers the low-cost EC2 production edge at
`api.rax-digital.com`. It does not change the accepted multi-replica production
architecture: the host and its Docker volumes remain single points of failure.

- backup interval: every six hours;
- object retention: 35 days;
- restore verification: weekly and after each deployment;
- self-hosted RPO: up to six hours;
- recovery objective: 60 minutes after a replacement host is ready.

## Automated evidence

Systemd owns three timers:

```bash
systemctl list-timers 'rax-compute-gateway-*'
journalctl -u rax-compute-gateway-backup.service --since '24 hours ago'
journalctl -u rax-compute-gateway-restore-verify.service --since '8 days ago'
journalctl -u rax-compute-gateway-monitor.service --since '30 minutes ago'
```

Successful backup output reports only the S3 object key and byte count. The
credential material and database rows are never printed. Restore verification
downloads `production/latest.json`, verifies SHA-256, restores into a uniquely
named disposable database, checks `tenants`, `api_keys`, and
`schema_migrations`, then drops the database.

CloudWatch metrics use namespace `RAX/ComputeGateway`:

- `ProductionBackupSuccess`;
- `ProductionRestoreVerificationSuccess`;
- `ProductionRestoreVerificationAgeSeconds` (reported every five minutes;
  alarms after eight days without a successful verification);
- `ProductionDiskUsagePercent`;
- `ProductionServiceReady`.

## Manual backup and verification

Use Session Manager or an approved SSM command. Do not use SSH.

```bash
sudo systemctl start rax-compute-gateway-backup.service
sudo systemctl status rax-compute-gateway-backup.service --no-pager
sudo systemctl start rax-compute-gateway-restore-verify.service
sudo systemctl status rax-compute-gateway-restore-verify.service --no-pager
```

## Recovery procedure

1. Declare the incident and record the latest successful backup manifest.
2. Stop public traffic or return maintenance responses before restoring.
3. Provision a replacement host from the documented production baseline.
4. Deploy the last approved `main` commit without creating client traffic.
5. Download `production/latest.json` and the referenced dump from the private
   backup bucket; verify its SHA-256 before use.
6. Restore into a new PostgreSQL database first. Never overwrite the only
   production database as the first restore attempt.
7. Run migrations compatible with the selected application release.
8. Verify tenant/key counts, `/health/ready`, all provider aliases, streaming,
   and authentication using a disposable client key.
9. Switch the gateway database URL during an approved deployment and restore
   public traffic gradually.
10. Record actual RPO/RTO, backup object version, deployment SHA, and follow-up
    actions without recording credentials or customer content.

If the latest backup fails checksum or restore validation, select the preceding
versioned manifest. Do not delete suspect evidence during the incident.
