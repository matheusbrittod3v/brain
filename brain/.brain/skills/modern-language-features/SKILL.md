---
name: modern-language-features
description: >-
  Guia de recursos modernos de ponta em TypeScript 5+, JavaScript ES2024+, Bun Runtime
  e PostgreSQL: operador satisfies, const type parameters, explicit resource management (using),
  Object.groupBy, Promise.withResolvers, non-mutating arrays e recursos nativos de alto desempenho.
---

# Modern Language Features Craftsman

Aproveite ao máximo os recursos modernos das linguagens e runtimes modernos (TypeScript 5+, ECMAScript 2024+, Bun e PostgreSQL avançado) para escrever código mais conciso, seguro, legível e de alto desempenho.

---

## 1. TypeScript 5+ Moderno

### 1.1. Operador `satisfies` (Validação de Tipo sem Widening)
O operador `satisfies` garante que um objeto respeita uma interface ou tipo sem alargar os tipos literais específicos de suas chaves e propriedades:

```typescript
type Palette = Record<string, string | [number, number, number]>;

// Sem satisfies: o TypeScript alarga as propriedades para string | [number, number, number]
// Com satisfies: valida a estrutura e preserva os literais e métodos específicos!
const theme = {
  primary: "#3b82f6",
  secondary: [59, 130, 246]
} satisfies Palette;

// O TypeScript sabe exatamente que 'primary' é string:
console.log(theme.primary.toUpperCase()); // ✅ Totalmente seguro!
```

### 1.2. `const` Type Parameters
Permite inferir tipos literais profundos em chamadas de função sem a necessidade de escrever `as const` na chamada:

```typescript
// ❌ Antes:
function declareRules<T extends readonly string[]>(rules: T) { return rules; }
const r1 = declareRules(["BR-001", "BR-002"] as const);

// ✅ Depois (TypeScript 5.0+):
function declareRules<const T extends readonly string[]>(rules: T) { return rules; }
const r2 = declareRules(["BR-001", "BR-002"]); // Tipo inferido: readonly ["BR-001", "BR-002"]
```

### 1.3. Explicit Resource Management (`using` & `Symbol.dispose`)
Descarte automático e determinístico de recursos (conexões de banco, arquivos, locks e leases) inspirado no `using` do C# e `with` do Python:

```typescript
class DatabaseTransaction implements Disposable {
  constructor(private readonly client: Client) {}

  [Symbol.dispose]() {
    this.client.rollback();
    console.log("Transação encerrada ou com rollback automático garantido.");
  }

  commit() {
    this.client.commit();
  }
}

function processBatch() {
  using tx = new DatabaseTransaction(db);
  // Se qualquer erro for lançado aqui, tx[Symbol.dispose]() será chamado automaticamente!
  tx.commit();
}
```

---

## 2. ECMAScript 2024+ (Modern JavaScript)

### 2.1. Métodos Imutáveis de Array (`toSorted`, `toReversed`, `toSpliced`, `with`)
Elimine mutações acidentais no array original:

```typescript
const scores = [85, 42, 99, 12];

// ❌ Antes (mutava o array original):
// scores.sort((a, b) => a - b);

// ✅ Depois: Retorna um novo array ordenado sem tocar em 'scores'
const sortedScores = scores.toSorted((a, b) => a - b);

// Substituição limpa de um elemento por índice:
const updatedScores = scores.with(1, 50); // [85, 50, 99, 12]
```

### 2.2. `Object.groupBy` e `Map.groupBy`
Agrupamento nativo de coleções sem precisar de bibliotecas externas (como Lodash) ou `reduce` manual:

```typescript
const items: KnowledgeItem[] = [...];

// Agrupa itens por camada em uma única linha legível:
const itemsByLayer = Object.groupBy(items, (item) => item.metadata?.knowledgeLayer ?? "other");
// Retorno: { business: KnowledgeItem[], architecture: KnowledgeItem[], ... }
```

### 2.3. `Promise.withResolvers()`
Substitui a criação manual de promessas com closures de `resolve` e `reject`:

```typescript
// ❌ Antes:
let resolveFn!: (val: number) => void;
let rejectFn!: (err: Error) => void;
const p = new Promise<number>((res, rej) => { resolveFn = res; rejectFn = rej; });

// ✅ Depois:
const { promise, resolve, reject } = Promise.withResolvers<number>();
```

### 2.4. `structuredClone` Nativo
Clonagem profunda rápida e segura sem perdas de tipos de data, sets ou maps:

```typescript
const deepCopy = structuredClone(complexKnowledgeGraph);
```

---

## 3. Primitivas de Alto Desempenho do Bun

O runtime Bun oferece APIs nativas ultrarrápidas em substituição às chamadas lentas do Node.js tradicional:

```typescript
// Leitura e escrita ultrarrápida com buffers nativos
const configFile = Bun.file(".brain/config.json");
const exists = await configFile.exists();
const jsonContent = await configFile.json();

// Hashing criptográfico nativo de senhas
const hash = await Bun.password.hash("user-password", { algorithm: "argon2id" });
const isValid = await Bun.password.verify("user-password", hash);
```

---

## 4. Recursos Avançados do PostgreSQL

1. **Upsert Atômico com `ON CONFLICT DO UPDATE`**:
   Garante idempotência sem necessidade de `SELECT` prévio.
2. **Campos Gerados (`GENERATED ALWAYS AS ... STORED`)**:
   Indexação vetorial de texto completo (`to_tsvector`) calculada automaticamente pelo banco na inserção.
3. **Filtros JSONB Indexáveis (`@>`)**:
   Buscas instantâneas em propriedades complexas de metadados:
   ```sql
   SELECT id FROM knowledge_items WHERE metadata @> '{"knowledgeLayer": "business"}';
   ```

---

## 5. Checklist de Boas Práticas
- [ ] O arquivo respeita estritamente o limite de 700 linhas?
- [ ] Foram evitadas mutações acidentais em arrays utilizando `toSorted()`, `toReversed()` ou spread?
- [ ] Agrupamentos utilizam `Object.groupBy` nativo?
- [ ] O operador `satisfies` foi utilizado para validação estrita preservando literais?
- [ ] Não há clonagem com `JSON.parse(JSON.stringify())`; usa-se `structuredClone`?
