import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import type { EnvironmentId, OpenCodeSessionSource, ProviderInstanceId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";

import { openCodeEnvironment } from "../../state/opencode";
import { ComposerInlineControl } from "../../components/ComposerToolbar";

export function OpenCodeSessionPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly source: OpenCodeSessionSource | undefined;
  readonly editable: boolean;
  readonly onSourceChange: (source: OpenCodeSessionSource | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sessionsQuery = openCodeEnvironment.sessions({
    environmentId: props.environmentId,
    input: { instanceId: props.instanceId, cwd: props.cwd ?? "" },
  });
  const result = useAtomValue(sessionsQuery);
  const refresh = useAtomRefresh(sessionsQuery);
  const sessions = AsyncResult.isSuccess(result) ? result.value.sessions : [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle.length === 0
      ? sessions
      : sessions.filter((session) =>
          [session.title, session.id].some((value) => value?.toLocaleLowerCase().includes(needle)),
        );
  }, [query, sessions]);
  const selectedSessionId = props.source?.type === "existing" ? props.source.sessionId : undefined;
  const selected = selectedSessionId
    ? sessions.find((session) => session.id === selectedSessionId)
    : undefined;

  if (!props.editable) {
    return (
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {selected?.title ?? "OpenCode session"}
      </Text>
    );
  }

  return (
    <>
      <ComposerInlineControl
        accessibilityLabel="OpenCode session"
        disabled={props.cwd === null}
        emphasized
        icon="clock.arrow.circlepath"
        label={selected?.title ?? "New session"}
        maxWidth={180}
        onPress={() => setOpen(true)}
      />
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View className="flex-1 bg-sheet px-5 pb-8 pt-16">
          <View className="mb-4 flex-row items-center justify-between">
            <Text className="text-xl font-t3-medium text-foreground">OpenCode session</Text>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)}>
              <Text className="text-sm text-accent">Done</Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="Search OpenCode sessions"
            className="mb-3 rounded-xl bg-input px-3 py-3 text-foreground"
            onChangeText={setQuery}
            placeholder="Search previous sessions"
            placeholderTextColor="#888"
            value={query}
          />
          <Pressable
            accessibilityRole="button"
            className="border-b border-border py-3"
            onPress={() => {
              props.onSourceChange({ type: "new" });
              setOpen(false);
            }}
          >
            <Text className="text-base text-foreground">New OpenCode session</Text>
          </Pressable>
          {AsyncResult.isFailure(result) ? (
            <Pressable accessibilityRole="button" className="py-4" onPress={refresh}>
              <Text className="text-sm text-danger">Could not load sessions. Tap to retry.</Text>
            </Pressable>
          ) : null}
          <FlatList
            data={filtered}
            keyExtractor={(session) => session.id}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                className="border-b border-border py-3"
                onPress={() => {
                  props.onSourceChange({ type: "existing", sessionId: item.id });
                  setOpen(false);
                }}
              >
                <Text className="text-base text-foreground" numberOfLines={1}>
                  {item.title ?? item.id}
                </Text>
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {item.id}
                </Text>
              </Pressable>
            )}
          />
        </View>
      </Modal>
    </>
  );
}
