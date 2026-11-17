import re
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Noema AI Worker", version="0.1.0")

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
CPF_RE = re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")

try:
    from presidio_analyzer import AnalyzerEngine
    from presidio_anonymizer import AnonymizerEngine
    _presidio_analyzer = AnalyzerEngine()
    _presidio_anonymizer = AnonymizerEngine()
except Exception:
    _presidio_analyzer = None
    _presidio_anonymizer = None

try:
    from docling.document_converter import DocumentConverter
    _docling_converter = DocumentConverter()
except Exception:
    _docling_converter = None


try:
    from flashrank import Ranker, RerankRequest
    _flashrank = Ranker()
except Exception:
    _flashrank = None


class TextPayload(BaseModel):
    text: str


class DocumentPayload(BaseModel):
    file_path: str


@app.get("/health")
def health():
    return {
        "service": "noema-ai-worker",
        "status": "ok",
        "presidio": _presidio_analyzer is not None,
        "docling": _docling_converter is not None,
    }


@app.post("/redact-pii")
def redact_pii(payload: TextPayload):
    if _presidio_analyzer is not None and _presidio_anonymizer is not None:
        results = _presidio_analyzer.analyze(text=payload.text, language="en")
        anonymized = _presidio_anonymizer.anonymize(text=payload.text, analyzer_results=results)
        redacted = EMAIL_RE.sub("[EMAIL_REDACTED]", anonymized.text)
        redacted = CPF_RE.sub("[CPF_REDACTED]", redacted)
        return {"redacted_text": redacted, "redacted": redacted, "engine": "presidio+regex"}

    redacted = EMAIL_RE.sub("[EMAIL_REDACTED]", payload.text)
    redacted = CPF_RE.sub("[CPF_REDACTED]", redacted)
    return {"redacted_text": redacted, "redacted": redacted, "engine": "regex-fallback"}


@app.post("/parse-document")
def parse_document(payload: DocumentPayload):
    if _docling_converter is not None:
        result = _docling_converter.convert(payload.file_path)
        return {"markdown": result.document.export_to_markdown(), "engine": "docling"}
    raise HTTPException(status_code=501, detail="Docling não instalado neste ambiente.")


class RerankDocument(BaseModel):
    id: str
    text: str


class RerankPayload(BaseModel):
    query: str
    documents: list[RerankDocument] | None = None
    passages: list[str] | None = None


@app.post("/rerank")
def rerank_passages(payload: RerankPayload):
    docs: list[dict[str, str]] = []
    if payload.documents:
        docs = [{"id": d.id, "text": d.text} for d in payload.documents]
    elif payload.passages:
        docs = [{"id": str(i), "text": t} for i, t in enumerate(payload.passages)]

    if not docs:
        return {"ranked_ids": [], "results": [], "engine": "empty"}

    if _flashrank is not None:
        req = RerankRequest(query=payload.query, passages=docs)
        ranked = _flashrank.rerank(req)
        results = [
            {"id": str(r["id"]), "score": float(r["score"]), "text": r["text"]}
            for r in ranked
        ]
        return {
            "ranked_ids": [r["id"] for r in results],
            "results": results,
            "engine": "flashrank",
        }

    query_terms = set(payload.query.lower().split())
    scored = []
    for d in docs:
        words = set(d["text"].lower().split())
        overlap = len(query_terms & words) / max(1, len(query_terms))
        scored.append({"id": d["id"], "score": overlap, "text": d["text"]})
    scored.sort(key=lambda item: item["score"], reverse=True)
    return {
        "ranked_ids": [item["id"] for item in scored],
        "results": scored,
        "engine": "lexical-overlap-rerank",
    }
