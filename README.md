# session-share

Compartilha uma sessão do Claude Code com outro usuário. O compartilhamento é **somente leitura**, **cifrado de ponta a ponta** e sincronizado a cada resposta.

- Quem compartilha não precisa de conta nem de credencial. O servidor gera um token de escrita que fica só na máquina de quem compartilha.
- O link de quem acompanha só lê. Nada do que essa pessoa faz volta para a sessão original.
- O servidor guarda apenas dados cifrados. A chave AES-256 está no link e nunca é enviada à API.

## Uso

| Quem | Comando | Efeito |
|---|---|---|
| Dono | `/share-session` | gera `/join-session <link>` e passa a sincronizar a cada resposta |
| Dono | `/unshare-session` | revoga o link e apaga os dados no servidor |
| Convidado | `/join-session <link>` | importa a sessão e mostra `claude --resume <id>` |

Na sessão importada, cada prompt do convidado recebe como contexto o que o dono fez desde a mensagem anterior.

Requisito: Node.js 18 ou mais recente.

## Instalação (usuário final)

```
/plugin marketplace add felipecosta/session-share
/plugin install session-share@session-share
```

## Deploy do backend

Requer AWS SAM CLI e um perfil AWS local. As credenciais ficam só na sua máquina e nunca no repositório.

```bash
cd backend && sam deploy --stack-name session-share --resolve-s3 --capabilities CAPABILITY_IAM --profile <seu-perfil> --region us-east-2
```

Se o `ApiUrl` mudar, atualize `API_URL` em `plugin/bin/ss.mjs`.

## Teste

```bash
cd backend && npm install && npm test
```

O teste roda o handler real atrás de um servidor HTTP local, com um S3 em memória e os hooks do plugin como processos separados.

## Limites

- Os shares expiram em 7 dias (`RetentionDays`). Cada share tem no máximo 50 chunks de 512 KB (cerca de 25 MB de sessão). Ao passar disso, a sincronização para.
- O throttling do API Gateway é global, não por IP. Para limitar por IP, use REST API com WAF.
- O redact remove os formatos mais comuns de token e chave. O resto do conteúdo da sessão (arquivos lidos, saídas de comando) é compartilhado como está.
