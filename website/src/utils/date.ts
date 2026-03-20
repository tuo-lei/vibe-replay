export const formatDate = (date: Date, month: "short" | "long" = "short") =>
  date.toLocaleDateString("en-US", { month, day: "numeric", year: "numeric", timeZone: "UTC" });
