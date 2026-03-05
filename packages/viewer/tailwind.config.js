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
          border: "var(--border)",
          text: "var(--text)",
          dim: "var(--dim)",
          green: "var(--green)",
          blue: "var(--blue)",
          orange: "var(--orange)",
          red: "var(--red)",
          purple: "var(--purple)",
        },
      },
    },
  },
  plugins: [],
};
