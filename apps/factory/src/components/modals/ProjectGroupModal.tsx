import { useState, type FormEvent } from "react";
import type { FactoryGroup, FactoryOverviewSnapshot } from "@t3tools/contracts/factory";
import { Button } from "../../design-system/actions";
import {
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogHeader,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
} from "../../design-system/forms";
import type { FactoryConnectionApi } from "../../factory/FactoryConnection";
import styles from "./ProjectGroupModal.module.css";

interface ProjectGroupModalProps {
  readonly open: boolean;
  readonly group?: FactoryGroup;
  readonly snapshot: FactoryOverviewSnapshot;
  readonly connection: FactoryConnectionApi;
  readonly onClose: () => void;
}

function projectIdentity(project: {
  readonly environmentId: string;
  readonly projectId: string;
}): string {
  return JSON.stringify([project.environmentId, project.projectId]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectGroupModal({
  open,
  group,
  snapshot,
  connection,
  onClose,
}: ProjectGroupModalProps) {
  const [name, setName] = useState(group?.name ?? "");
  const [selectedProjects, setSelectedProjects] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        snapshot.memberships
          .filter((membership) => membership.groupId === group?.id)
          .map((membership) => projectIdentity(membership.project)),
      ),
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const setProjectSelected = (projectKey: string, selected: boolean) => {
    setSelectedProjects((current) => {
      const next = new Set(current);
      if (selected) next.add(projectKey);
      else next.delete(projectKey);
      return next;
    });
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setError("Enter a group name.");
      return;
    }
    setPending(true);
    setError(undefined);
    let createdGroup = false;
    try {
      let groupId = group?.id;
      if (group === undefined) {
        const created = await connection.request((client) =>
          client["factory.groups.create"]({ name: cleanName }),
        );
        groupId = created.id;
        createdGroup = true;
      } else if (cleanName !== group.name) {
        await connection.request((client) =>
          client["factory.groups.update"]({
            groupId: group.id,
            revision: group.revision,
            name: cleanName,
          }),
        );
      }
      if (groupId === undefined) throw new Error("The factory did not return the new group ID.");

      const current = new Set(
        snapshot.memberships
          .filter((membership) => membership.groupId === groupId)
          .map((membership) => projectIdentity(membership.project)),
      );
      for (const project of snapshot.projects) {
        const key = projectIdentity(project.key);
        const shouldBelong = selectedProjects.has(key);
        if (shouldBelong === current.has(key)) continue;
        const reference = {
          environmentId: project.key.environmentId,
          projectId: project.key.projectId,
        };
        if (shouldBelong) {
          await connection.request((client) =>
            client["factory.groups.assign"]({ groupId, project: reference }),
          );
        } else {
          await connection.request((client) =>
            client["factory.groups.unassign"]({ groupId, project: reference }),
          );
        }
      }
      onClose();
    } catch (cause) {
      const prefix =
        group === undefined
          ? createdGroup
            ? "The group was created, but its project assignments may be incomplete. Check the overview before trying again."
            : "The group creation result is uncertain. Check the overview before trying again."
          : "Some group changes may have been applied. Check the overview before trying again.";
      setError(`${prefix} ${errorMessage(cause)}`);
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (group === undefined) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await connection.request((client) =>
        client["factory.groups.delete"]({
          groupId: group.id,
          revision: group.revision,
        }),
      );
      if (!result.deleted) throw new Error("The factory did not delete the group.");
      onClose();
    } catch (cause) {
      setError(
        `The group could not be deleted. Check the revision and factory status. ${errorMessage(cause)}`,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open && !pending) onClose();
      }}
    >
      <DialogSurface size="medium">
        <form className={styles.form} onSubmit={save}>
          <DialogHeader>
            <DialogTitle>{group ? "Edit project group" : "Create project group"}</DialogTitle>
          </DialogHeader>
          <DialogBody className={styles.body}>
            <p className={styles.guidance}>
              Groups contain whole projects. They do not move workspaces or stop agents.
            </p>
            {error ? (
              <MessageBar intent="error" role="alert">
                {error}
              </MessageBar>
            ) : null}
            <Field label="Group name" required>
              <Input
                value={name}
                onChange={(_, data) => setName(data.value)}
                maxLength={80}
                required
              />
            </Field>
            <Field label="Projects">
              <div className={styles.projects}>
                {snapshot.projects.map((project) => {
                  const key = projectIdentity(project.key);
                  const environment = snapshot.environments.find(
                    (item) => item.environmentId === project.key.environmentId,
                  );
                  return (
                    <Checkbox
                      key={key}
                      checked={selectedProjects.has(key)}
                      onChange={(_, data) => setProjectSelected(key, Boolean(data.checked))}
                      label={`${project.title} · ${environment?.label ?? project.key.environmentId} · ${project.workspaceRoot}`}
                    />
                  );
                })}
                {snapshot.projects.length === 0 ? (
                  <p className={styles.empty}>No projects are available.</p>
                ) : null}
              </div>
            </Field>
          </DialogBody>
          <DialogActions className={styles.actions}>
            {group ? (
              <Button
                type="button"
                appearance="subtle"
                disabled={pending}
                onClick={() => void remove()}
              >
                Delete group
              </Button>
            ) : null}
            <Button type="button" appearance="secondary" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" appearance="primary" disabled={pending}>
              {pending ? "Saving…" : "Save group"}
            </Button>
          </DialogActions>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
