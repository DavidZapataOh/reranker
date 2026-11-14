import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { expectNoAxeViolations } from "../../test/axe.ts";
import { CodeField } from "./CodeField.tsx";

afterEach(cleanup);

const field = (root: HTMLElement) => {
  const el = root.querySelector("input");
  if (!el) throw new Error("input not rendered");
  return el;
};

// The browser-mode paste() takes no text, so the event is dispatched with a real DataTransfer.
function paste(input: HTMLInputElement, text: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  input.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
  );
}

test("a dirty paste keeps six digits and completes once", async () => {
  const onComplete = vi.fn();
  const { container } = await render(
    <CodeField name="code" label="Código" onComplete={onComplete} />,
  );
  const input = field(container);
  await userEvent.click(input);
  paste(input, "123 456");
  expect(input.value).toBe("123456");
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith("123456");
});

test("pasted prose and over-long codes are cleaned", async () => {
  const onComplete = vi.fn();
  const { container } = await render(
    <CodeField name="code" label="Código" onComplete={onComplete} />,
  );
  const input = field(container);
  await userEvent.click(input);
  paste(input, "Tu código es 123-456");
  expect(input.value).toBe("123456");
  expect(onComplete).toHaveBeenCalledTimes(1);
  await userEvent.clear(input);
  paste(input, "1234567");
  expect(input.value).toBe("123456");
  expect(onComplete).toHaveBeenCalledTimes(2);
  expect(onComplete).toHaveBeenLastCalledWith("123456");
});

test("an autofilled dirty value is cleaned without the paste event", async () => {
  const onComplete = vi.fn();
  const { container } = await render(
    <CodeField name="code" label="Código" onComplete={onComplete} />,
  );
  const input = field(container);
  // Autofill assigns the value programmatically, so maxLength does not truncate it.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    input,
    "Tu código es 123-456",
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(input.value).toBe("123456");
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith("123456");
});

test("deleting a digit and retyping it completes again", async () => {
  const onComplete = vi.fn();
  const { container } = await render(
    <CodeField name="code" label="Código" onComplete={onComplete} />,
  );
  const input = field(container);
  await userEvent.click(input);
  paste(input, "123456");
  await userEvent.keyboard("{Backspace}");
  expect(onComplete).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("6");
  expect(onComplete).toHaveBeenCalledTimes(2);
  expect(onComplete).toHaveBeenLastCalledWith("123456");
});

test("without onComplete the surrounding form submits exactly once", async () => {
  const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
  const { container } = await render(
    <form onSubmit={onSubmit}>
      <CodeField name="code" label="Código" />
    </form>,
  );
  const input = field(container);
  await userEvent.click(input);
  await userEvent.keyboard("123456");
  expect(input.value).toBe("123456");
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("wrong and expired codes show their own message linked to the input", async () => {
  for (const msg of [
    "Ese código no es el que te mandamos. Revisa el último correo",
    "Ese código ya venció. Te mandamos uno nuevo",
  ]) {
    const { container } = await render(<CodeField name="code" label="Código" error={msg} />);
    const input = field(container);
    const id = input.getAttribute("aria-describedby");
    const errorEl = id ? container.ownerDocument.getElementById(id) : null;
    expect(errorEl?.textContent).toBe(msg);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await cleanup();
  }
});

test("the cells are 48 by 56 and the input has no axe violations in every state", async () => {
  for (const props of [
    {},
    { error: "Ese código ya venció. Te mandamos uno nuevo" },
    { disabled: true },
  ]) {
    const { container } = await render(<CodeField name="code" label="Código" {...props} />);
    await expectNoAxeViolations(container);
    const cell = container.querySelector('[aria-hidden="true"] > *');
    const rect = cell?.getBoundingClientRect();
    expect([rect?.width, rect?.height]).toEqual([48, 56]);
    await cleanup();
  }
});

test("the six cells fit a 320 px screen with its 16 px gutters", async () => {
  await page.viewport(320, 640);
  const { container } = await render(
    <div className="px-4">
      <CodeField name="code" label="Código" />
    </div>,
  );
  const cells = [...container.querySelectorAll('[aria-hidden="true"] > *')];
  expect(cells.at(-1)?.getBoundingClientRect().right).toBeLessThanOrEqual(304);
  expect(field(container).getBoundingClientRect().right).toBeLessThanOrEqual(304);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
});

test("the input is a target of at least 48 px and shows focus on its cells", async () => {
  const { container } = await render(<CodeField name="code" label="Código" />);
  const input = field(container);
  const rect = input.getBoundingClientRect();
  expect(rect.height).toBeGreaterThanOrEqual(48);
  await userEvent.tab();
  expect(document.activeElement).toBe(input);
});
