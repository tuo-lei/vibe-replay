/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        accent: "#00e5a0",
        "accent-dim": "#00c88a",
        surface: "#0a0a0f",
        "surface-1": "#111118",
        "surface-2": "#1a1a24",
        "surface-3": "#24243a",
        border: "#2a2a3e",
        "text-primary": "#e8e8f0",
        "text-secondary": "#8888a0",
        "text-muted": "#555568",
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "SF Mono",
          "Consolas",
          "monospace",
        ],
      },
      animation: {
        "fade-in": "fadeIn 0.6s ease-out",
        "slide-up": "slideUp 0.6s ease-out",
        glow: "glow 3s ease-in-out infinite alternate",
        blink: "blink 1s step-end infinite",
        typing: "typing 4s steps(40) infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        glow: {
          "0%": { boxShadow: "0 0 20px rgba(0, 229, 160, 0.1)" },
          "100%": { boxShadow: "0 0 40px rgba(0, 229, 160, 0.2)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
    },
  },
  plugins: [],
};
