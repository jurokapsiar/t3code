import { useMemo, useState } from "react";
import type {
  FactoryFavoriteTarget,
  FactoryGroup,
  FactoryOverviewSnapshot,
} from "@t3tools/contracts/factory";
import { ArrowDown, ArrowRight, ArrowUp, FolderGit2, Layers, Server, Star } from "lucide-react";
import { Badge, Button, Card, CardFooter, CardHeader, Tooltip } from "../../design-system/actions";
import { MessageBar } from "../../design-system/forms";
import type { FactoryConnectionApi } from "../../factory/FactoryConnection";
import { overviewProjectKey } from "../../factory/overviewSelectors";
import { useT3Store } from "../../store/useT3Store";
import { getSessionStatePresentation } from "./sessionState";
import { ProjectGroupModal } from "../modals/ProjectGroupModal";
import styles from "./FavoriteProjectsGrid.module.css";

interface FavoriteProjectsGridProps {
  readonly snapshot: FactoryOverviewSnapshot;
  readonly connection: FactoryConnectionApi;
  readonly onShowAll: () => void;
}

type FavoriteCard =
  | {
      readonly kind: "group";
      readonly id: string;
      readonly favorite: Extract<FactoryFavoriteTarget, { readonly kind: "group" }>;
      readonly group: FactoryGroup;
    }
  | {
      readonly kind: "project";
      readonly id: string;
      readonly favorite: Extract<FactoryFavoriteTarget, { readonly kind: "project" }>;
      readonly project: FactoryOverviewSnapshot["projects"][number];
    };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGroupTarget(
  target: FactoryFavoriteTarget,
): target is Extract<FactoryFavoriteTarget, { readonly kind: "group" }> {
  return target.kind === "group";
}

export function FavoriteProjectsGrid({
  snapshot,
  connection,
  onShowAll,
}: FavoriteProjectsGridProps) {
  const setSelectedTarget = useT3Store((state) => state.setSelectedTarget);
  const setGroupFilter = useT3Store((state) => state.setGroupFilter);
  const setSearchQuery = useT3Store((state) => state.setSearchQuery);
  const expandedRowIds = useT3Store((state) => state.expandedRowIds);
  const setExpandedRows = useT3Store((state) => state.setExpandedRows);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [editingGroup, setEditingGroup] = useState<FactoryGroup>();

  const favoriteCards = useMemo<FavoriteCard[]>(() => {
    const cards: FavoriteCard[] = [];
    for (const favorite of [...snapshot.favorites].sort((a, b) => a.order - b.order)) {
      const target = favorite.target;
      if (isGroupTarget(target)) {
        const group = snapshot.groups.find((item) => item.id === target.groupId);
        if (group) cards.push({ kind: "group", id: group.id, favorite: target, group });
        continue;
      }
      const project = snapshot.projects.find(
        (item) => overviewProjectKey(item) === overviewProjectKey({ key: target.project }),
      );
      if (project)
        cards.push({ kind: "project", id: overviewProjectKey(project), favorite: target, project });
    }
    return cards;
  }, [snapshot]);

  const changeFavorite = async (target: FactoryFavoriteTarget, favorite: boolean) => {
    const key = JSON.stringify(target);
    setPending(key);
    setError(undefined);
    try {
      await connection.request((client) => client["factory.favorites.set"]({ target, favorite }));
    } catch (cause) {
      setError(`The factory could not update this favorite. ${errorText(cause)}`);
    } finally {
      setPending(undefined);
    }
  };

  const moveFavorite = async (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= favoriteCards.length) return;
    const reordered = [...snapshot.favorites]
      .sort((a, b) => a.order - b.order)
      .map((item) => item.target);
    const currentKey = JSON.stringify(favoriteCards[index].favorite);
    const nextKey = JSON.stringify(favoriteCards[nextIndex].favorite);
    const currentTargetIndex = reordered.findIndex(
      (target) => JSON.stringify(target) === currentKey,
    );
    const nextTargetIndex = reordered.findIndex((target) => JSON.stringify(target) === nextKey);
    if (currentTargetIndex < 0 || nextTargetIndex < 0) return;
    [reordered[currentTargetIndex], reordered[nextTargetIndex]] = [
      reordered[nextTargetIndex],
      reordered[currentTargetIndex],
    ];
    setPending("reorder");
    setError(undefined);
    try {
      await connection.request((client) =>
        client["factory.favorites.reorder"]({
          targets: reordered,
        }),
      );
    } catch (cause) {
      setError(`The factory could not reorder favorites. ${errorText(cause)}`);
    } finally {
      setPending(undefined);
    }
  };

  const openFavorite = (favorite: FactoryFavoriteTarget) => {
    setSearchQuery("");
    setGroupFilter(favorite.kind === "group" ? favorite.groupId : "all");
    onShowAll();
    const sessions =
      favorite.kind === "group"
        ? snapshot.threads.filter((thread) =>
            snapshot.memberships.some(
              (membership) =>
                membership.groupId === favorite.groupId &&
                membership.project.environmentId === thread.project.environmentId &&
                membership.project.projectId === thread.project.projectId,
            ),
          )
        : snapshot.threads.filter(
            (thread) =>
              thread.project.environmentId === favorite.project.environmentId &&
              thread.project.projectId === favorite.project.projectId,
          );
    const target = sessions[0]?.key;
    if (target) {
      const parentId =
        favorite.kind === "group"
          ? `group:${favorite.groupId}`
          : `project:${overviewProjectKey({ key: favorite.project })}`;
      setExpandedRows([...new Set([...expandedRowIds, parentId])]);
      setSelectedTarget(target, "split");
    }
  };

  return (
    <>
      <section className={styles.section} aria-labelledby="favorite-projects-heading">
        <header className={styles.sectionHeader}>
          <div className={styles.sectionTitleGroup}>
            <Star className={styles.sectionIcon} size={16} fill="currentColor" aria-hidden="true" />
            <h2 id="favorite-projects-heading" className={styles.sectionTitle}>
              Pinned projects and groups
            </h2>
            <Badge appearance="tint" color="neutral" mono size="small">
              {favoriteCards.length}
            </Badge>
          </div>
          <p className={styles.sectionDescription}>Shared favorites from the factory.</p>
        </header>
        {error ? (
          <MessageBar intent="error" role="alert">
            {error}
          </MessageBar>
        ) : null}
        {favoriteCards.length === 0 ? (
          <Card appearance="outline" className={styles.emptyCard}>
            <Star className={styles.emptyIcon} size={24} aria-hidden="true" />
            <p className={styles.emptyTitle}>No pinned projects or groups</p>
            <p className={styles.emptyDescription}>Pin a project or group in the list below.</p>
          </Card>
        ) : (
          <div className={styles.grid}>
            {favoriteCards.map((item, index) => {
              const isGroup = item.kind === "group";
              const name = isGroup ? item.group.name : item.project.title;
              const target = item.favorite;
              const project = isGroup ? undefined : item.project;
              const groupSessions = isGroup
                ? snapshot.threads.filter((thread) =>
                    snapshot.memberships.some(
                      (membership) =>
                        membership.groupId === item.group.id &&
                        membership.project.environmentId === thread.project.environmentId &&
                        membership.project.projectId === thread.project.projectId,
                    ),
                  )
                : [];
              const projectSessions = project
                ? snapshot.threads.filter(
                    (thread) =>
                      thread.project.environmentId === project.key.environmentId &&
                      thread.project.projectId === project.key.projectId,
                  )
                : groupSessions;
              const latest = projectSessions[0];
              const presentation = latest
                ? getSessionStatePresentation(latest.classification)
                : undefined;
              const environment = project
                ? snapshot.environments.find(
                    (source) => source.environmentId === project.key.environmentId,
                  )
                : undefined;
              const favoriteKey = JSON.stringify(target);
              return (
                <Card
                  key={`${item.kind}:${item.id}`}
                  appearance="filled"
                  interactive
                  className={styles.projectCard}
                >
                  <CardHeader
                    header={
                      <div className={styles.cardHeading}>
                        {isGroup ? (
                          <Layers className={styles.folderIcon} size={18} aria-hidden="true" />
                        ) : (
                          <FolderGit2 className={styles.folderIcon} size={18} aria-hidden="true" />
                        )}
                        <h3 className={styles.projectName}>{name}</h3>
                      </div>
                    }
                    action={
                      <div className={styles.cardActions}>
                        <Tooltip content="Move favorite up" relationship="label">
                          <Button
                            appearance="subtle"
                            size="small"
                            icon={<ArrowUp size={14} />}
                            aria-label={`Move ${name} up`}
                            disabled={index === 0 || pending !== undefined}
                            onClick={() => void moveFavorite(index, -1)}
                          />
                        </Tooltip>
                        <Tooltip content="Move favorite down" relationship="label">
                          <Button
                            appearance="subtle"
                            size="small"
                            icon={<ArrowDown size={14} />}
                            aria-label={`Move ${name} down`}
                            disabled={index === favoriteCards.length - 1 || pending !== undefined}
                            onClick={() => void moveFavorite(index, 1)}
                          />
                        </Tooltip>
                        <Tooltip content="Unpin favorite" relationship="label">
                          <Button
                            appearance="transparent"
                            size="small"
                            icon={<Star size={16} fill="currentColor" />}
                            aria-label={`Unpin ${name}`}
                            disabled={pending === favoriteKey}
                            className={styles.unpinButton}
                            onClick={() => void changeFavorite(target, false)}
                          />
                        </Tooltip>
                      </div>
                    }
                    className={styles.cardHeader}
                  />
                  <div className={styles.cardContent}>
                    {project ? (
                      <>
                        <Badge appearance="outline" color="brand" mono icon={<Server size={13} />}>
                          {environment?.label ?? project.key.environmentId}
                        </Badge>
                        <Tooltip content={project.workspaceRoot} relationship="description">
                          <code className={styles.projectPath}>{project.workspaceRoot}</code>
                        </Tooltip>
                      </>
                    ) : item.kind === "group" ? (
                      <Badge appearance="outline" color="neutral">
                        {item.group.id}
                      </Badge>
                    ) : null}
                  </div>
                  <CardFooter className={styles.cardFooter}>
                    {presentation ? (
                      <Badge
                        appearance="tint"
                        color={presentation.color}
                        dot
                        pulse={presentation.pulse}
                        className={styles.statusBadge}
                      >
                        {presentation.label} · {projectSessions.length}
                      </Badge>
                    ) : (
                      <Badge appearance="outline" color="neutral" className={styles.statusBadge}>
                        {project ? "No sessions" : `${projectSessions.length} sessions`}
                      </Badge>
                    )}
                    <Button
                      appearance="secondary"
                      size="small"
                      icon={<ArrowRight size={14} />}
                      onClick={() => openFavorite(target)}
                    >
                      View
                    </Button>
                    {item.kind === "group" ? (
                      <Button
                        appearance="subtle"
                        size="small"
                        onClick={() => setEditingGroup(item.group)}
                      >
                        Edit group
                      </Button>
                    ) : null}
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </section>
      {editingGroup ? (
        <ProjectGroupModal
          open
          group={editingGroup}
          snapshot={snapshot}
          connection={connection}
          onClose={() => setEditingGroup(undefined)}
        />
      ) : null}
    </>
  );
}
