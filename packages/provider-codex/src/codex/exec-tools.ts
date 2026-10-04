import { parse, type Node } from "acorn";

type AstNode = Node & Record<string, any>;
export interface NestedExecTool {
  name: string;
  input: Record<string, any>;
}

const UNKNOWN = Symbol("unknown literal");

/**
 * Read the straight-line, awaited calls in a completed functions.exec script.
 * Never evaluate transcript JavaScript. Conditional/looped, unawaited, dynamic
 * dispatch and incomplete scripts stay as one opaque exec invocation.
 */
export function nestedExecTools(source: string, result: string): NestedExecTool[] | undefined {
  try {
    return readNestedExecTools(source, result);
  } catch {
    // Malformed or deeply nested source must not prevent replaying the batch.
    return undefined;
  }
}

function readNestedExecTools(source: string, result: string): NestedExecTool[] | undefined {
  if (source.length > 256_000 || !/^Script completed\b/.test(result)) return undefined;
  let program: AstNode;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "module" }) as AstNode;
  } catch {
    return undefined;
  }
  const bindings = new Map<string, unknown>();
  const calls: NestedExecTool[] = [];
  let toolCallCount = 0;
  let unsafe = false;
  visit(program, (node, parent) => {
    // A tool reference used as a value can escape through an alias, callback,
    // destructuring or reflective dispatch. Partial expansion would lose it.
    if (isToolsMember(node) && !(parent?.type === "CallExpression" && parent.callee === node))
      unsafe = true;
    if (node.type === "Identifier" && node.name === "tools") {
      const memberObject = parent?.type === "MemberExpression" && parent.object === node;
      const propertyName =
        (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
        (parent?.type === "Property" &&
          parent.key === node &&
          !parent.computed &&
          !parent.shorthand);
      if (!memberObject && !propertyName) unsafe = true;
    }
    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      let target = node.left || node.argument;
      while (target?.type === "MemberExpression") target = target.object;
      if (target?.type === "Identifier" && target.name === "tools") unsafe = true;
    }
    if (node.type !== "CallExpression") return;
    if (isToolsMember(node.callee)) toolCallCount++;
    if (node.callee.type === "Identifier" && node.callee.name === "exit") unsafe = true;
  });

  function expression(node: AstNode, awaited = false): void {
    if (node.type === "AwaitExpression") {
      expression(node.argument, true);
    } else if (node.type === "CallExpression") {
      if (isToolsMember(node.callee)) {
        const name = memberName(node.callee, bindings);
        if (!awaited || typeof name !== "string") {
          unsafe = true;
          return;
        }
        const value = literal(node.arguments[0], bindings);
        // Missing dynamic inputs would turn real edits into misleading zeros.
        if (value === UNKNOWN) {
          unsafe = true;
          return;
        }
        calls.push({
          name,
          input: typeof value === "string" ? { value } : (value as Record<string, any>) || {},
        });
      } else if (
        awaited &&
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Promise" &&
        ["all", "allSettled"].includes(memberName(node.callee, bindings) || "") &&
        node.arguments[0]?.type === "ArrayExpression"
      ) {
        for (const child of node.arguments[0].elements) {
          if (child) expression(child, true);
        }
      } else {
        // Arguments are evaluated; callback/function bodies are not.
        for (const argument of node.arguments) expression(argument);
      }
    } else if (node.type === "ArrayExpression") {
      for (const child of node.elements) if (child) expression(child);
    } else if (node.type === "ObjectExpression") {
      for (const property of node.properties) {
        if (property.type === "Property") expression(property.value);
      }
    } else if (node.type === "AssignmentExpression" || node.type === "SequenceExpression") {
      if (node.right) expression(node.right);
      for (const child of node.expressions || []) expression(child);
    }
  }

  for (const statement of program.body) {
    if (statement.type === "ExpressionStatement") expression(statement.expression);
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (!declaration.init) continue;
        expression(declaration.init);
        if (declaration.id.type === "Identifier") {
          if (declaration.id.name === "tools") unsafe = true;
          const value = literal(declaration.init, bindings);
          // Object bindings can be mutated elsewhere. Only immutable primitive
          // constants are safe to substitute without executing the script.
          bindings.set(
            declaration.id.name,
            statement.kind === "const" && ["string", "number", "boolean"].includes(typeof value)
              ? value
              : UNKNOWN,
          );
        }
      }
    }
  }
  return !unsafe && calls.length > 0 && calls.length === toolCallCount ? calls : undefined;
}

function isToolsMember(node: AstNode): boolean {
  return (
    node?.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "tools"
  );
}

function memberName(node: AstNode, bindings: Map<string, unknown>): string | undefined {
  const key = node.computed ? literal(node.property, bindings) : node.property.name;
  return typeof key === "string" ? key : undefined;
}

function literal(node: AstNode | undefined, bindings: Map<string, unknown>): unknown {
  if (!node) return undefined;
  if (node.type === "Literal") return node.regex || node.bigint ? UNKNOWN : node.value;
  if (node.type === "Identifier") {
    return node.name === "undefined" ? undefined : (bindings.get(node.name) ?? UNKNOWN);
  }
  if (node.type === "TemplateLiteral") {
    let value = node.quasis[0].value.cooked;
    for (let i = 0; i < node.expressions.length; i++) {
      const child = literal(node.expressions[i], bindings);
      if (!["string", "number", "boolean"].includes(typeof child)) return UNKNOWN;
      value += String(child) + node.quasis[i + 1].value.cooked;
    }
    return value;
  }
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const value = literal(node.argument, bindings);
    return typeof value === "number" ? -value : UNKNOWN;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = literal(node.left, bindings);
    const right = literal(node.right, bindings);
    if (typeof left === "string" && typeof right === "string") return left + right;
    if (typeof left === "number" && typeof right === "number") return left + right;
    return UNKNOWN;
  }
  if (node.type === "ArrayExpression") {
    const value = node.elements.map((child: AstNode) => literal(child, bindings));
    return value.includes(UNKNOWN) ? UNKNOWN : value;
  }
  if (node.type === "ObjectExpression") {
    const value: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      if (property.type !== "Property" || property.kind !== "init" || property.method)
        return UNKNOWN;
      const key = property.computed
        ? literal(property.key, bindings)
        : property.key.name || property.key.value;
      const child = literal(property.value, bindings);
      if (typeof key !== "string" || child === UNKNOWN) return UNKNOWN;
      value[key] = child;
    }
    return value;
  }
  return UNKNOWN;
}

function visit(
  node: AstNode,
  callback: (node: AstNode, parent?: AstNode) => void,
  parent?: AstNode,
): void {
  callback(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) visit(child, callback, node);
    } else if (value?.type) visit(value, callback, node);
  }
}

/** Literal patch headers are the complete touched-path list, including moves. */
export function patchFilePaths(patch: string): string[] {
  return [
    ...new Set(
      [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)]
        .map((match) => (match[1] || match[2]).trim())
        .filter(Boolean),
    ),
  ];
}
