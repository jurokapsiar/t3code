export interface PresentationState {
  theme: "dark" | "light";
}

export function migratePresentationState(input: unknown): PresentationState {
  const theme =
    typeof input === "object" && input !== null && !Array.isArray(input) && "theme" in input
      ? input.theme
      : undefined;
  return { theme: theme === "light" || theme === "dark" ? theme : "dark" };
}
