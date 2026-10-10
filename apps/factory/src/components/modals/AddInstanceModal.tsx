import { useEffect, useState, type FormEvent } from "react";
import type { FactoryEnvironmentView } from "@t3tools/contracts/factory";
import { useQueryClient } from "@tanstack/react-query";
import { Server, X } from "lucide-react";
import { Button } from "../../design-system/actions";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  Select,
} from "../../design-system/forms";
import type { FactoryConnectionApi } from "../../factory/FactoryConnection";
import { factoryKeys } from "../../factory/queryKeys";
import {
  enrollSensitiveCredential,
  serializeSensitiveOperationError,
} from "../../factory/sensitiveOperations";
import {
  buildEnvironmentDetails,
  buildEnvironmentEdit,
  defaultEnvironmentAddress,
  parseEnvironmentEndpoint,
} from "../nodes/nodesModel";
import styles from "./AddInstanceModal.module.css";

export type AddInstanceModalMode = "register" | "edit" | "reenroll";

interface AddInstanceModalProps {
  readonly connection: FactoryConnectionApi;
  readonly factoryId: string;
  readonly mode: AddInstanceModalMode;
  readonly environment?: FactoryEnvironmentView;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}

export function AddInstanceModal({
  connection,
  factoryId,
  mode,
  environment,
  open,
  onOpenChange,
  onSaved,
}: AddInstanceModalProps) {
  const queryClient = useQueryClient();
  const endpointImmutable =
    mode === "edit" && environment !== undefined && environment.credentialStorage !== null;
  const [scheme, setScheme] = useState<"http" | "https">(defaultEnvironmentAddress.scheme);
  const [host, setHost] = useState(defaultEnvironmentAddress.host);
  const [port, setPort] = useState(defaultEnvironmentAddress.port);
  const [label, setLabel] = useState("");
  const [sourceCredential, setSourceCredential] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    const endpoint =
      environment === undefined ? null : parseEnvironmentEndpoint(environment.endpoint);
    setScheme(endpoint?.scheme ?? defaultEnvironmentAddress.scheme);
    setHost(endpoint?.host ?? defaultEnvironmentAddress.host);
    setPort(endpoint?.port ?? defaultEnvironmentAddress.port);
    setLabel(environment?.label ?? "");
    setSourceCredential("");
    setError(
      environment !== undefined &&
        mode !== "reenroll" &&
        environment.credentialStorage === null &&
        endpoint === null
        ? "This endpoint cannot be split into host, port, and scheme. Enter a valid endpoint to replace it."
        : undefined,
    );
  }, [environment, mode, open]);

  const close = () => {
    if (pending) return;
    setSourceCredential("");
    setError(undefined);
    onOpenChange(false);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setPending(true);
    try {
      if (mode === "reenroll") {
        if (environment === undefined) {
          setError("The source is not available. Reload the Nodes view and try again.");
          return;
        }
        if (sourceCredential.length === 0) {
          setError("Enter the one-time source credential.");
          return;
        }
        await enrollSensitiveCredential(connection, {
          endpoint: environment.endpoint,
          label: environment.label,
          sourceCredential,
        });
      } else {
        const details = buildEnvironmentDetails({ scheme, host, port, label });
        if (!details.ok) {
          setError(details.error);
          return;
        }
        if (mode === "edit") {
          if (environment === undefined) {
            setError("The source is not available. Reload the Nodes view and try again.");
            return;
          }
          const edit = buildEnvironmentEdit(environment, { scheme, host, port, label });
          if (!edit.ok) {
            setError(edit.error);
            return;
          }
          await connection.request((client) => client["factory.environments.update"](edit.input));
        } else {
          if (sourceCredential.length === 0) {
            setError("Enter the one-time source credential.");
            return;
          }
          await enrollSensitiveCredential(connection, {
            endpoint: details.endpoint,
            label: details.label,
            sourceCredential,
          });
        }
      }
      await queryClient.invalidateQueries({ queryKey: factoryKeys.environments(factoryId) });
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(
        mode === "edit"
          ? "The factory could not update this source. Reload its status and try again."
          : serializeSensitiveOperationError(cause).message,
      );
    } finally {
      setSourceCredential("");
      setPending(false);
    }
  };

  const title =
    mode === "register"
      ? "Register a serve source"
      : mode === "edit"
        ? "Edit serve source"
        : "Re-enroll serve source";

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) close();
      }}
    >
      <DialogSurface size="small">
        <form className={styles.form} onSubmit={handleSubmit}>
          <DialogHeader className={styles.dialogHeader}>
            <DialogTitle>
              <span className={styles.titleContent}>
                <Server size={16} aria-hidden="true" /> {title}
              </span>
            </DialogTitle>
            <Button
              type="button"
              appearance="subtle"
              icon={<X size={16} />}
              aria-label="Close dialog"
              disabled={pending}
              onClick={close}
            />
          </DialogHeader>
          <DialogBody className={styles.dialogBody}>
            <div className={styles.fields}>
              {error ? (
                <MessageBar intent="error" role="alert">
                  {error}
                </MessageBar>
              ) : null}
              {mode === "reenroll" && environment !== undefined ? (
                <div className={styles.sourceSummary}>
                  <p>
                    <strong>{environment.label}</strong>
                  </p>
                  <code>{environment.endpoint}</code>
                </div>
              ) : (
                <>
                  <Field label="Source name" required>
                    <Input
                      value={label}
                      onChange={(_, data) => setLabel(data.value)}
                      required
                      maxLength={120}
                    />
                  </Field>
                  {endpointImmutable && environment !== undefined ? (
                    <>
                      <div className={styles.sourceSummary}>
                        <code>{environment.endpoint}</code>
                      </div>
                      <p className={styles.helpText}>
                        An enrolled source endpoint cannot be changed. Remove this source and
                        register it again to use a different endpoint.
                      </p>
                    </>
                  ) : (
                    <div className={styles.hostFields}>
                      <Field label="Scheme">
                        <Select
                          value={scheme}
                          onChange={(_, data) =>
                            setScheme(data.value === "https" ? "https" : "http")
                          }
                        >
                          <option value="http">HTTP</option>
                          <option value="https">HTTPS</option>
                        </Select>
                      </Field>
                      <Field label="Host" required>
                        <Input
                          value={host}
                          onChange={(_, data) => setHost(data.value)}
                          placeholder="127.0.0.1 or serve.example"
                          required
                        />
                      </Field>
                      <Field label="Port" required>
                        <Input
                          type="number"
                          min={1}
                          max={65535}
                          value={port}
                          onChange={(_, data) => setPort(data.value)}
                          required
                        />
                      </Field>
                    </div>
                  )}
                </>
              )}
              {mode !== "edit" ? (
                <>
                  <Field
                    label="One-time source credential"
                    required
                    hint="Sent to the factory for enrollment. It is not saved in this browser."
                  >
                    <Input
                      type="password"
                      autoComplete="off"
                      value={sourceCredential}
                      onChange={(_, data) => setSourceCredential(data.value)}
                      required
                    />
                  </Field>
                  <p className={styles.helpText}>
                    On the source machine, run <code>t3 pair --label &quot;T3 Factory&quot;</code>,
                    or create a pairing link in Settings → Connections. Paste the printed token
                    here. It expires after five minutes by default and works once. Do not open the
                    pairing link first; that can consume it.
                  </p>
                  <p className={styles.helpText}>
                    Running from a checkout? Switch to Node 24 first (with nvm, run{" "}
                    <code>nvm use 24</code>). Then, from the t3code root, run{" "}
                    <code>node apps/server/src/bin.ts pair --label &quot;T3 Factory&quot;</code>.
                    Node 22.12 cannot run this TypeScript entry directly. If the server uses a
                    custom data directory, add <code>--base-dir /path/to/server-home</code>.
                  </p>
                </>
              ) : null}
              <p className={styles.helpText}>
                Credential storage is selected by the factory host administrator. The browser cannot
                enable file storage.
              </p>
            </div>
          </DialogBody>
          <DialogActions className={styles.dialogActions}>
            <Button type="button" appearance="secondary" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" appearance="primary" disabled={pending}>
              {pending
                ? "Working…"
                : mode === "register"
                  ? "Register source"
                  : mode === "edit"
                    ? "Save changes"
                    : "Re-enroll source"}
            </Button>
          </DialogActions>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
