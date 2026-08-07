// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ReplayImage from "../ReplayImage";

afterEach(cleanup);

describe("ReplayImage", () => {
  it("renders embedded images without consent", () => {
    render(<ReplayImage src="data:image/png;base64,abc" alt="Embedded" className="image" />);

    expect(screen.getByRole("img", { name: "Embedded" }).getAttribute("src")).toBe(
      "data:image/png;base64,abc",
    );
    expect(screen.queryByText("Load external image")).toBeNull();
  });

  it("does not attach an external URL until the user approves loading", () => {
    const src = "https://images.example.test/private.png?token=signed";
    render(<ReplayImage src={src} alt="External" className="image" />);

    expect(screen.queryByRole("img", { name: "External" })).toBeNull();
    expect(document.querySelector(`img[src="${src}"]`)).toBeNull();
    expect(screen.getByText("This will contact images.example.test.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load external image" }));

    const image = screen.getByRole("img", { name: "External" });
    expect(image.getAttribute("src")).toBe(src);
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("never attaches unsupported image protocols", () => {
    render(<ReplayImage src="javascript:alert(1)" alt="Unsupported" className="image" />);

    expect(screen.queryByRole("img", { name: "Unsupported" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load external image" })).toBeNull();
    expect(screen.getByText("Unsupported image source")).toBeTruthy();
  });
});
