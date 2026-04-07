type StructuralTopic = "polymorphism" | "inheritance" | "abstraction" | "encapsulation" | "composition";

export const JAVA_STRUCTURAL_TOPICS: readonly StructuralTopic[] = [
  "polymorphism",
  "inheritance",
  "abstraction",
  "encapsulation",
  "composition",
];

function normalizeTopic(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "");
}

function hasStructuralTopic(topics: string[], topic: StructuralTopic): boolean {
  const key = topic.toLowerCase();
  return topics.some((t) => normalizeTopic(t).includes(key));
}

export function hasJavaStructuralTopics(topics: string[]): boolean {
  return JAVA_STRUCTURAL_TOPICS.some((topic) => hasStructuralTopic(topics, topic));
}

type JavaTypeIndex = {
  publicClassName: string | null;
  interfaces: string[];
  abstractClasses: string[];
  classes: Array<{ name: string; extendsName: string | null; implementsNames: string[] }>;
};

function indexJavaTypes(source: string): JavaTypeIndex {
  const s = String(source ?? "");
  const interfaces: string[] = [];
  const abstractClasses: string[] = [];
  const classes: Array<{ name: string; extendsName: string | null; implementsNames: string[] }> = [];

  const publicClassName = /\bpublic\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(s)?.[1] ?? null;

  {
    const re = /\binterface\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (m[1]) interfaces.push(m[1]);
    }
  }

  {
    const re = /\babstract\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (m[1]) abstractClasses.push(m[1]);
    }
  }

  {
    const re =
      /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b(?:\s+extends\s+([A-Za-z_][A-Za-z0-9_]*))?(?:\s+implements\s+([^{]+))?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const name = m[1] ?? null;
      if (!name) continue;
      const extendsName = m[2] ?? null;
      const implementsRaw = m[3] ?? "";
      const implementsNames = implementsRaw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      classes.push({ name, extendsName, implementsNames });
    }
  }

  return {
    publicClassName,
    interfaces: Array.from(new Set(interfaces)),
    abstractClasses: Array.from(new Set(abstractClasses)),
    classes,
  };
}

function pickStatefulPrimaryClass(index: JavaTypeIndex): string | null {
  // Avoid treating "Main" as the primary domain object for OOP structural checks.
  if (index.publicClassName && index.publicClassName !== "Main") return index.publicClassName;
  const nonMain = index.classes.map((c) => c.name).find((n) => n && n !== "Main") ?? null;
  return nonMain;
}

function pickBaseType(index: JavaTypeIndex): string | null {
  return index.interfaces[0] ?? index.abstractClasses[0] ?? null;
}

function findImplementations(index: JavaTypeIndex, base: string): string[] {
  const out: string[] = [];
  for (const c of index.classes) {
    if (c.name === base) continue;
    if (c.extendsName === base) out.push(c.name);
    if (c.implementsNames.includes(base)) out.push(c.name);
  }
  return Array.from(new Set(out));
}

function requireTestMentions(testSuite: string, names: string[], ctx: string) {
  const ts = String(testSuite ?? "");
  for (const n of names) {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`);
    if (!re.test(ts)) {
      throw new Error(`Structural topic requirement failed (${ctx}): test_suite must mention "${n}".`);
    }
  }
}

function requireTwoMethodCallsOnSameInstance(testSuite: string, className: string, ctx: string) {
  const ts = String(testSuite ?? "");
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\b${escaped}\\b\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*new\\s+${escaped}\\s*\\(`).exec(ts);
  if (!m?.[1]) {
    throw new Error(
      `Structural topic requirement failed (${ctx}): test_suite must assign a "${className}" instance to a variable so it can exercise stateful behavior.`
    );
  }
  const varName = m[1];
  const calls: string[] = [];
  const re = new RegExp(`\\b${varName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, "g");
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(ts)) !== null) {
    if (mm[1]) calls.push(mm[1]);
  }
  const uniq = Array.from(new Set(calls));
  if (uniq.length < 2) {
    throw new Error(
      `Structural topic requirement failed (${ctx}): test_suite must call at least 2 distinct methods on the same "${className}" instance.`
    );
  }
}

function requiredStructuralTopics(topics: string[]): StructuralTopic[] {
  const required: StructuralTopic[] = [];
  const add = (t: StructuralTopic) => required.push(t);
  if (hasStructuralTopic(topics, "polymorphism")) add("polymorphism");
  if (hasStructuralTopic(topics, "inheritance")) add("inheritance");
  if (hasStructuralTopic(topics, "abstraction")) add("abstraction");
  if (hasStructuralTopic(topics, "encapsulation")) add("encapsulation");
  if (hasStructuralTopic(topics, "composition")) add("composition");
  return Array.from(new Set(required));
}

export function assertJavaStructuralTopicRequirements(args: {
  topics: string[];
  referenceSource: string;
  testSuite: string;
}): void {
  const required = requiredStructuralTopics(args.topics);
  if (required.length === 0) return;

  const index = indexJavaTypes(args.referenceSource);
  const publicClass = pickStatefulPrimaryClass(index);

  for (const topic of required) {
    if (topic === "polymorphism") {
      const base = pickBaseType(index);
      if (!base) {
        throw new Error(
          'Structural topic requirement failed (polymorphism): reference solution must define an interface or abstract class to serve as a base type.'
        );
      }
      const impls = findImplementations(index, base);
      if (impls.length < 2) {
        throw new Error(
          `Structural topic requirement failed (polymorphism): must include at least 2 concrete implementations of "${base}".`
        );
      }
      requireTestMentions(args.testSuite, [base, impls[0]!, impls[1]!], "polymorphism");
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const baseVarAssigned = new RegExp(`\\b${escaped}\\b\\s+\\w+\\s*=\\s*new\\s+\\w+\\b`).test(args.testSuite);
      if (!baseVarAssigned) {
        throw new Error(
          `Structural topic requirement failed (polymorphism): test_suite must assign a "${base}" reference to a concrete implementation to exercise dynamic dispatch.`
        );
      }
      continue;
    }

    if (topic === "abstraction") {
      const base = pickBaseType(index);
      if (!base) {
        throw new Error(
          'Structural topic requirement failed (abstraction): reference solution must define an interface or abstract class.'
        );
      }
      const impls = findImplementations(index, base);
      if (impls.length < 1) {
        throw new Error(
          `Structural topic requirement failed (abstraction): must include at least 1 implementation of "${base}".`
        );
      }
      requireTestMentions(args.testSuite, [base, impls[0]!], "abstraction");
      continue;
    }

    if (topic === "inheritance") {
      const pair = index.classes.find((c) => c.extendsName != null && c.extendsName !== "Object");
      if (!pair?.extendsName) {
        throw new Error(
          "Structural topic requirement failed (inheritance): reference solution must include a subclass that extends a base class."
        );
      }
      const base = pair.extendsName;
      const sub = pair.name;

      const overrideMethod =
        /@Override\s+public\s+[\w<>\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(args.referenceSource)?.[1] ?? null;
      if (!overrideMethod) {
        throw new Error(
          `Structural topic requirement failed (inheritance): subclass "${sub}" must override at least one method (use @Override).`
        );
      }

      requireTestMentions(args.testSuite, [base, sub], "inheritance");
      const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedSub = sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const baseTypedRef = new RegExp(`\\b${escapedBase}\\b\\s+\\w+\\s*=\\s*new\\s+${escapedSub}\\b`).test(args.testSuite);
      if (!baseTypedRef) {
        throw new Error(
          `Structural topic requirement failed (inheritance): test_suite must reference subclass behavior via a "${base}"-typed variable assigned to "${sub}".`
        );
      }
      const escapedMethod = overrideMethod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`\\.${escapedMethod}\\s*\\(`).test(args.testSuite)) {
        throw new Error(
          `Structural topic requirement failed (inheritance): test_suite must call the overridden method "${overrideMethod}".`
        );
      }
      continue;
    }

    if (topic === "composition") {
      if (!publicClass) {
        throw new Error(
          'Structural topic requirement failed (composition): reference solution must include a non-"Main" class suitable for composition checks.'
        );
      }
      const others = index.classes.map((c) => c.name).filter((n) => n !== publicClass);
      if (others.length < 1) {
        throw new Error(
          `Structural topic requirement failed (composition): "${publicClass}" must compose at least one other type (define an additional class).`
        );
      }
      const fieldType =
        others.find((t) => new RegExp(`\\b(?:private|protected)\\s+(?:final\\s+)?${t}\\b\\s+\\w+\\s*;`).test(args.referenceSource)) ??
        null;
      if (!fieldType) {
        throw new Error(
          `Structural topic requirement failed (composition): "${publicClass}" must have a private/protected field of another declared type.`
        );
      }
      requireTestMentions(args.testSuite, [publicClass, fieldType], "composition");
      continue;
    }

    if (topic === "encapsulation") {
      if (!publicClass) {
        throw new Error(
          'Structural topic requirement failed (encapsulation): reference solution must include a non-"Main" class suitable for encapsulation checks.'
        );
      }
      if (!/\bprivate\s+[^;]+;/.test(args.referenceSource)) {
        throw new Error(
          `Structural topic requirement failed (encapsulation): "${publicClass}" must include at least one private field.`
        );
      }
      // Best-effort: detect public field declarations (avoid matching method bodies/calls).
      if (/\bpublic\s+(?!class|interface|enum)[^;\n()]*\s+[A-Za-z_][A-Za-z0-9_]*\s*;/.test(args.referenceSource)) {
        throw new Error(
          `Structural topic requirement failed (encapsulation): "${publicClass}" must not expose public fields (use methods).`
        );
      }
      requireTwoMethodCallsOnSameInstance(args.testSuite, publicClass, "encapsulation");
      continue;
    }
  }
}

export const __test__ = {
  normalizeTopic,
  indexJavaTypes,
  pickBaseType,
  findImplementations,
};
