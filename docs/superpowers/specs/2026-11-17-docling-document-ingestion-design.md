# Ingestão de documentos com Docling

## Intenção

Permitir que um usuário autenticado ingira PDF, DOCX, PPTX, HTML e planilhas pelo Hub, convertendo-os em Markdown estruturado localmente pelo Docling antes dos gates de segurança existentes. Isso fecha a lacuna entre o Docling instalado no AI Worker e o endpoint atual, que aceita um caminho arbitrário do filesystem e não participa da ingestão do Hub.

## Objetivos

- Adicionar `POST /v1/projects/:projectId/ingest-document` com nome, bytes base64 e política opcional.
- Restringir a formatos documentados, tamanho codificado em 16 MiB e nome sem separadores de caminho.
- Fazer o AI Worker converter bytes em arquivo temporário com extensão validada; remover o arquivo em `finally`.
- Preferir Docling e usar MarkItDown local como fallback se Docling estiver ausente ou falhar; falhar fechado se ambos falharem.
- Executar Gitleaks no Markdown extraído, sanitizar PII quando `AI_WORKER_URL` estiver configurado, aplicar OPA/política, persistir item, auditar e enfileirar embedding conforme o fluxo existente.
- Não persistir conteúdo bruto do documento nem expor caminho local ao chamador.
- Persistir uploads como `status=draft`, `sourceOrigin=external_reference`, `sourceKind=api` e `trustLevel=untrusted`, independentemente do conteúdo extraído.

## Não objetivos

- OCR avançado, tabelas perfeitas ou garantia de fidelidade visual.
- Ingestão em lote, arquivos compactados, URLs remotas ou caminhos do host.
- Substituir o endpoint JSON `/v1/projects/:projectId/ingest` para texto e Markdown.

## Abordagens consideradas

1. **Upload autenticado no Hub e conversão por AI Worker (escolhida):** mantém credenciais e autorização no Hub; o worker recebe bytes e limita a operação a um arquivo temporário. Reutiliza os serviços e gates atuais.
2. **CLI local chama Docling diretamente:** offline, mas duplica dependências e gates entre clientes, e não cria o item sincronizado com auditoria no Hub.
3. **Aceitar caminho local no AI Worker:** simples, porém dá ao chamador da rede capacidade de ler arquivos acessíveis ao processo; rejeitada por risco de exposição.

## Decisões de implementação

- Formatos: `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.html`, `.htm` e `.csv`. Formatos Office binários antigos (`.doc`, `.xls`, `.ppt`) exigem LibreOffice, ausente da imagem atual, e ficam fora deste contrato.
- Limite de arquivo: 16 MiB antes da codificação base64; a API limita o JSON a 24 MiB para acomodar expansão base64.
- Transporte Hub→Worker: JSON com `file_name` e `content_base64`; o AI Worker valida extensão, base64, conteúdo vazio e tamanho e converte via `DocumentConverter`.
- O AI Worker não aceita nem retorna caminhos. O endpoint de parsing legado passa a exigir o contrato seguro por bytes.
- O item usa URI `.brain/imported-documents/<nome-normalizado>.md`; políticas são verificadas pelo Hub e conteúdo é sempre sujeito a Gitleaks.
- Docling é o parser principal; MarkItDown local é fallback se Docling estiver ausente ou rejeitar/falhar na conversão. Ausência/falha de ambos retorna erro e nada é persistido.

## Restrições e riscos

- A conversão pode consumir CPU/memória; limite de tamanho e timeout do request reduzem, mas não eliminam, risco de arquivos malformados.
- Dependências OCR de sistema podem variar; os testes usam conversor injetado e o ambiente live usa documento sintético.
- O teste não afirma qualidade de OCR em scans reais.

## Critério de aceite

Um DOCX sintético passa pela rota autenticada, é extraído, detectado pelo Gitleaks/redator e persiste como um item pesquisável; um arquivo com segredo extraído, formato não permitido, base64 inválido, excesso de tamanho ou Docling indisponível não cria item.
