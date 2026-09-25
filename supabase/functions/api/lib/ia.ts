// Categorização opcional com a API do Claude, para itens que nenhuma regra reconheceu.
// Só é usada se a chave da Anthropic estiver configurada no app.

export async function categorizarComIA(
  apiKey: string,
  descricoes: string[],
  categorias: string[],
  loja?: string | null,
): Promise<(string | null)[]> {
  if (!descricoes.length) return [];
  const lista = descricoes.map((d, i) => `${i + 1}. ${d}`).join("\n");
  const prompt =
    `Você categoriza itens de notas fiscais de consumidor brasileiras (descrições abreviadas).` +
    (loja ? ` Loja: ${loja}.` : "") +
    `\nCategorias permitidas (use exatamente um destes nomes):\n${categorias.join("\n")}\n\n` +
    `Itens:\n${lista}\n\n` +
    `Responda somente com um objeto JSON no formato {"1": "Categoria", "2": "Categoria", ...}.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`IA indisponível (${r.status})`);
  const j = await r.json();
  const texto: string = (j.content ?? []).map((c: any) => c.text ?? "").join("");
  const json = texto.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return descricoes.map(() => null);
  const mapa = JSON.parse(json) as Record<string, string>;
  const validas = new Set(categorias);
  return descricoes.map((_, i) => {
    const c = mapa[String(i + 1)];
    return c && validas.has(c) ? c : null;
  });
}
