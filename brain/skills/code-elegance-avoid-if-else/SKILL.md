---
name: code-elegance-avoid-if-else
description: >-
  Padrões modernos de engenharia para eliminar cadeias excessivas de if/else e
  complexidade ciclomática: guard clauses, lookup tables, strategy pattern,
  discriminated unions com matching exaustivo, pipelines funcionais e polimorfismo.
---

# Code Elegance & Avoiding If-Else Hell

Cadeias aninhadas de `if/else if/else` aumentam a complexidade ciclomática, dificultam testes, tornam a leitura árdua (efeito "Arrow Anti-Pattern") e violam o princípio Open/Closed (OCD). Este guia ensina técnicas comprovadas para escrever código limpo, elegante e manutenível.

---

## 1. Guard Clauses & Early Returns (The Bouncer Pattern)

Em vez de aninhar a lógica principal dentro de blocos condicionais profundos, faça checagens de saída rápida logo no início da função.

### ❌ Antes (Anti-Pattern: if aninhado em escada)
```typescript
function processPayment(user: User | null, amount: number) {
  if (user) {
    if (user.isActive) {
      if (amount > 0) {
        if (user.balance >= amount) {
          user.balance -= amount;
          return { success: true };
        } else {
          return { error: "INSUFFICIENT_FUNDS" };
        }
      } else {
        return { error: "INVALID_AMOUNT" };
      }
    } else {
      return { error: "USER_INACTIVE" };
    }
  } else {
    return { error: "USER_NOT_FOUND" };
  }
}
```

### ✅ Depois (Guard Clauses elegantes e legíveis)
```typescript
function processPayment(user: User | null, amount: number): Result {
  if (!user) return { error: "USER_NOT_FOUND" };
  if (!user.isActive) return { error: "USER_INACTIVE" };
  if (amount <= 0) return { error: "INVALID_AMOUNT" };
  if (user.balance < amount) return { error: "INSUFFICIENT_FUNDS" };

  user.balance -= amount;
  return { success: true };
}
```

---

## 2. Lookup Tables & Object/Map Dictionaries

Substitua longos `if/else if` ou `switch` por tabelas de busca indexadas (constantes de objeto ou instâncias de `Map`).

### ❌ Antes (if/else if para mapeamento de status)
```typescript
function getBadgeColor(status: string): string {
  if (status === "approved" || status === "active") {
    return "success";
  } else if (status === "pending" || status === "draft") {
    return "warning";
  } else if (status === "rejected" || status === "deprecated") {
    return "error";
  } else {
    return "neutral";
  }
}
```

### ✅ Depois (Lookup Table declarativa O(1))
```typescript
type ItemStatus = "approved" | "active" | "pending" | "draft" | "rejected" | "deprecated";

const STATUS_COLOR_MAP: Readonly<Record<ItemStatus, string>> = {
  approved: "success",
  active: "success",
  pending: "warning",
  draft: "warning",
  rejected: "error",
  deprecated: "error"
};

function getBadgeColor(status: string): string {
  return STATUS_COLOR_MAP[status as ItemStatus] ?? "neutral";
}
```

---

## 3. Discriminated Unions & Exhaustive Pattern Matching

Utilize uniões discriminadas em TypeScript para garantir em tempo de compilação que todos os casos sejam cobertos sem `else` implícito.

### Implementação de Exaustividade com `assertNever`:
```typescript
type NotificationEvent =
  | { type: "slack"; channel: string; message: string }
  | { type: "email"; recipient: string; subject: string; body: string }
  | { type: "webhook"; url: string; payload: Record<string, unknown> };

function assertNever(value: never): never {
  throw new Error(`Caso não tratado: ${JSON.stringify(value)}`);
}

function dispatchNotification(event: NotificationEvent): Promise<void> {
  const handlers: Record<NotificationEvent["type"], (e: any) => Promise<void>> = {
    slack: async (e) => sendToSlack(e.channel, e.message),
    email: async (e) => sendEmail(e.recipient, e.subject, e.body),
    webhook: async (e) => postWebhook(e.url, e.payload)
  };

  const handler = handlers[event.type];
  if (!handler) assertNever(event as never);
  return handler(event);
}
```

---

## 4. Strategy Pattern & Functional Dispatchers

Quando o comportamento varia substancialmente por tipo ou algoritmo, isole cada variante em uma função ou classe especializada.

### Exemplo: Cálculo de Desconto / Tarifação FinOps
```typescript
interface PricingStrategy {
  calculate(tokens: number, ratePerMillion: number): number;
}

const pricingStrategies: Record<ModelTier, PricingStrategy> = {
  fast: {
    calculate: (tokens, rate) => (tokens / 1_000_000) * rate
  },
  reasoning: {
    calculate: (tokens, rate) => (tokens / 1_000_000) * rate * 1.5
  },
  local_fallback: {
    calculate: () => 0 // Custo zero para inferência local Ollama
  }
};

export function computeTokenCost(tier: ModelTier, tokens: number, rate: number): number {
  const strategy = pricingStrategies[tier];
  return strategy ? strategy.calculate(tokens, rate) : 0;
}
```

---

## 5. Pipelines Declarativos em vez de Loops com `if`

Evite criar variáveis mutáveis acumuladoras preenchidas dentro de loops com condicionais. Use o poder da API funcional de coleções.

### ❌ Antes (Loop procedural com if)
```typescript
const highRiskRules: BusinessRule[] = [];
for (let i = 0; i < rules.length; i++) {
  const rule = rules[i];
  if (rule.status === "approved") {
    if (rule.metadata?.severity === "critical" || rule.metadata?.severity === "high") {
      if (rule.tags.includes("security")) {
        highRiskRules.push(rule);
      }
    }
  }
}
```

### ✅ Depois (Pipeline funcional fluente)
```typescript
const isCriticalOrHigh = (r: BusinessRule) =>
  r.metadata?.severity === "critical" || r.metadata?.severity === "high";

const isSecurityScoped = (r: BusinessRule) =>
  r.tags.includes("security");

const highRiskRules = rules
  .filter((r) => r.status === "approved")
  .filter(isCriticalOrHigh)
  .filter(isSecurityScoped);
```

---

## 6. Nullish Coalescing (`??`) e Optional Chaining (`?.`)

Substitua checagens manuais de `null` e `undefined`:

```typescript
// ❌ Antes:
const userDisplayName = user && user.profile && user.profile.name ? user.profile.name : "Anônimo";

// ✅ Depois:
const userDisplayName = user?.profile?.name ?? "Anônimo";
```

---

## Checklist de Revisão de Elegância de Código
- [ ] O arquivo tem zero blocos `if` aninhados com mais de 2 níveis de profundidade?
- [ ] Foi usado early return para validar pré-condições?
- [ ] Dicionários/Maps substituíram longos blocos `switch` ou `else if`?
- [ ] O compilador TypeScript valida a exaustividade das uniões discriminadas?
- [ ] O arquivo mantém-se rigorosamente abaixo do teto de 700 linhas?
