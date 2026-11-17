import json
import re
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError
from document_parser import MAX_DOCUMENT_BYTES, parse_document_upload

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
    from markitdown import MarkItDown
    _markitdown_converter = MarkItDown()
except Exception:
    _markitdown_converter = None


try:
    from flashrank import Ranker, RerankRequest
    _flashrank = Ranker()
except Exception:
    _flashrank = None


class TextPayload(BaseModel):
    text: str


class DocumentPayload(BaseModel):
    file_name: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(min_length=1, max_length=4 * ((MAX_DOCUMENT_BYTES + 2) // 3))


@app.get("/health")
def health():
    return {
        "service": "noema-ai-worker",
        "status": "ok",
        "presidio": _presidio_analyzer is not None,
        "docling": _docling_converter is not None,
        "markitdown": _markitdown_converter is not None,
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
async def parse_document(request: Request):
    max_request_bytes = 24 * 1024 * 1024
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_request_bytes:
                raise HTTPException(status_code=413, detail="Upload excede o limite de 16 MiB.")
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Content-Length inválido.") from error
    raw_body = bytearray()
    async for chunk in request.stream():
        raw_body.extend(chunk)
        if len(raw_body) > max_request_bytes:
            raise HTTPException(status_code=413, detail="Upload excede o limite de 16 MiB.")
    try:
        payload = DocumentPayload.model_validate(json.loads(raw_body))
    except (json.JSONDecodeError, ValidationError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=422, detail="Payload do documento inválido.") from error
    if _docling_converter is None and _markitdown_converter is None:
        raise HTTPException(status_code=503, detail="Docling e MarkItDown indisponíveis neste ambiente.")
    try:
        markdown, engine = parse_document_upload(
            payload.file_name, payload.content_base64,
            converter=_docling_converter, fallback_converter=_markitdown_converter
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=422, detail="Docling não conseguiu converter o documento.") from error
    return {"markdown": markdown, "engine": engine}


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
