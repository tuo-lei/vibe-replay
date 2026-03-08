/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: "var(--bg)",
          surface: "var(--surface)",
          "surface-hover": "var(--surface-hover)",
          "surface-2": "var(--surface-2)",
          "surface-inset": "var(--surface-inset)",
          border: "var(--border)",
          "border-subtle": "var(--border-subtle)",
          text: "var(--text)",
          dim: "var(--dim)",
          dimmer: "var(--dimmer)",
          green: "var(--green)",
          "green-subtle": "var(--green-subtle)",
          "green-emphasis": "var(--green-emphasis)",
          blue: "var(--blue)",
          "blue-subtle": "var(--blue-subtle)",
          "blue-emphasis": "var(--blue-emphasis)",
          orange: "var(--orange)",
          "orange-subtle": "var(--orange-subtle)",
          "orange-emphasis": "var(--orange-emphasis)",
          red: "var(--red)",
          "red-subtle": "var(--red-subtle)",
          "red-emphasis": "var(--red-emphasis)",
          purple: "var(--purple)",
          "purple-subtle": "var(--purple-subtle)",
          "purple-emphasis": "var(--purple-emphasis)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
      },
      boxShadow: {
        "layer-sm": "var(--shadow-sm)",
        "layer-md": "var(--shadow-md)",
        "layer-lg": "var(--shadow-lg)",
        "layer-xl": "var(--shadow-xl)",
      },
      transitionTimingFunction: {
        material: "cubic-bezier(0.4, 0, 0.2, 1)",
        "material-decel": "cubic-bezier(0.0, 0, 0.2, 1)",
        "material-accel": "cubic-bezier(0.4, 0, 1, 1)",
      },
    },
  },
  plugins: [],
};
