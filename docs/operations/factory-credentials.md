# Factory credentials

Factory mode stores source credentials in one backend for the installation. It
uses the OS credential vault by default. macOS uses Keychain, Linux uses Secret
Service, and Windows uses the system credential vault. Make the vault available
to the account that runs the server. A locked or unavailable vault causes the
operation to fail; T3 Code does not fall back to files.

## Headless hosts

Use protected-file storage only when the server cannot use an OS vault. Select it
explicitly:

```sh
t3 serve --factory --factory-credential-store=file
```

Or set `T3CODE_FACTORY_CREDENTIAL_STORE=file`. T3 Code stores the credentials
under `userdata/secrets/factory-credentials` with private directory and file
permissions. Protect this data directory from other local accounts. Encrypt any
backup that contains credentials.

## Backup and recovery

Back up the Factory database, `userdata/environment-id`, and the protected
credential directory from the same T3 home. Restore them as one set. The
environment identity keeps credential references stable across restarts. For
OS-vault storage, include the vault entries when your platform supports a secure
migration; otherwise enroll the sources again with fresh one-time pairing
credentials.

If you change the selected backend, first restore the old backend and remove
all source registrations. Then select the new backend and enroll the sources
again. T3 Code does not migrate credential entries between backends. If a
credential is missing after recovery, re-enroll its source with a fresh
one-time pairing credential. Keep the source row until the credential is
removed; a failed removal remains visible for retry.
