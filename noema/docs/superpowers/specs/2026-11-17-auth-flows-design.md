# Fluxos de autenticação — desenho curto

## Intenção

Deixar o acesso ao Hub Noema fácil de entender: mostrar quem está conectado, explicar como entrar com email e senha e separar a conta das integrações de IA/MCP e das chaves manuais.

## Escopo

- Identificar a sessão salva consultando `/v1/auth/me`, exibir estado de verificação e limpar usuário quando a chave não for válida ou a API não puder confirmá-la.
- Separar visualmente conta (entrar, criar conta, sessão ativa e sair) de integrações (OAuth2 para IA/MCP e configuração de chave/API).
- Incluir orientações curtas para entrar, criar conta, confirmar email quando necessário e lidar com senha esquecida, sem prometer recuperação que a API não oferece.
- Melhorar hierarquia visual, navegação e adaptação a telas estreitas, preservando os fluxos e chamadas existentes.

## Fora do escopo

- Criar redefinição de senha, novos endpoints ou alterar autenticação no servidor.
- Mudar cargos, permissões, política de cadastro ou fluxo OAuth2.

## Abordagens consideradas

1. **Manter as quatro abas juntas:** menor alteração, mas login e opções de integração continuam misturados.
2. **Separar conta e integrações — escolhida:** organizar a interface em duas áreas claras, mantendo as operações e endpoints atuais. Atende diretamente à separação solicitada sem redesenhar o sistema de autenticação.
3. **Criar páginas independentes:** separação mais forte, com navegação e mudanças de roteamento desnecessárias para esta janela.

## Critérios de conclusão

- Usuário consegue distinguir sessão ativa, sessão em verificação e ausência de login.
- Token inválido não deixa um usuário antigo exibido como conectado.
- Os passos de login e cadastro são claros, e OAuth2/chave manual continuam acessíveis na área de integrações.
- Textos correspondem aos recursos disponíveis na API.
