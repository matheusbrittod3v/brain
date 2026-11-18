package com.brain.brain

import com.intellij.openapi.components.Service
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Serviço JetBrains responsável pela ponte MCP (stdio e Streamable HTTP)
 * e disparo de handoffs para o Universal Agent Gateway do Brain.
 */
@Service(Service.Level.APP)
class BrainMcpService {

    enum class TransportMode {
        STREAMABLE_HTTP,
        STDIO
    }

    data class McpBridgeConfig(
        val transport: TransportMode = TransportMode.STREAMABLE_HTTP,
        val httpEndpoint: String = System.getenv("BRAIN_API_URL")?.trimEnd('/')?.plus("/mcp")
            ?: "http://localhost:3333/mcp",
        val stdioCommand: List<String> = listOf("npx", "-y", "@brain/mcp-server"),
        val apiKey: String? = System.getenv("BRAIN_LOCAL_API_KEY")
    )

    data class HandoffRequest(
        val projectId: String,
        val targetAgent: String,
        val summary: String,
        val files: List<String> = emptyList()
    )

    data class HandoffResponse(
        val statusCode: Int,
        val body: String
    )

    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    fun getBridgeConfig(mode: TransportMode = TransportMode.STREAMABLE_HTTP): McpBridgeConfig {
        return McpBridgeConfig(transport = mode)
    }

    fun buildStdioProcessBuilder(config: McpBridgeConfig = getBridgeConfig(TransportMode.STDIO)): ProcessBuilder {
        val builder = ProcessBuilder(config.stdioCommand)
        config.apiKey?.let { builder.environment()["BRAIN_LOCAL_API_KEY"] = it }
        builder.environment()["BRAIN_MCP_ENDPOINT"] = config.httpEndpoint
        return builder
    }

    fun triggerHandoff(request: HandoffRequest): HandoffResponse {
        val config = getBridgeConfig()
        val apiKey = config.apiKey
            ?: throw IllegalStateException("BRAIN_LOCAL_API_KEY não configurada para o plugin JetBrains.")

        val baseUrl = config.httpEndpoint.removeSuffix("/mcp")
        val targetUrl = "$baseUrl/v1/projects/${request.projectId}/handoffs"
        val filesJson = request.files.joinToString(",") { "\"${escapeJson(it)}\"" }
        val payload = """
            {
              "targetAgent": "${escapeJson(request.targetAgent)}",
              "summary": "${escapeJson(request.summary)}",
              "files": [$filesJson]
            }
        """.trimIndent()

        val httpRequest = HttpRequest.newBuilder()
            .uri(URI.create(targetUrl))
            .timeout(Duration.ofSeconds(15))
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer $apiKey")
            .POST(HttpRequest.BodyPublishers.ofString(payload))
            .build()

        val response = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) {
            throw RuntimeException("Brain handoff falhou: HTTP ${response.statusCode()} - ${response.body()}")
        }
        return HandoffResponse(statusCode = response.statusCode(), body = response.body())
    }

    private fun escapeJson(value: String): String {
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
    }
}
