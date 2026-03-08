import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const params = new URLSearchParams(window.location.search);
    const urlTheme = params.get("theme");
    if (urlTheme === "light" || urlTheme === "dark") return urlTheme;

    const stored = localStorage.getItem("vibe-replay-theme");
    if (stored === "light" || stored === "dark") return stored;
    return "dark";
  });

  useEffect(() => {
    const el = document.documentElement;
    // Enable transition class for smooth theme switch
    el.classList.add("theme-transition");
    el.classList.toggle("dark", theme === "dark");
    el.classList.toggle("light", theme === "light");
    localStorage.setItem("vibe-replay-theme", theme);
    // Remove transition class after animation completes to avoid interfering
    const timer = setTimeout(() => el.classList.remove("theme-transition"), 300);
    return () => clearTimeout(timer);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme };
}
