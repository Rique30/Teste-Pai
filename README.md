# Controle de Serviços Aéreos

Página para registrar ordens de serviço em aeroportos.

- **Planilha**: todas as OS em uma tabela editável (data, aeroporto, discriminação, checklist, status, nota fiscal e valor), com busca, filtro por status e total.
- **OS**: cada ordem de serviço com data, local, prestador, valor, discriminação e checklist com OK.
- **Checklist padrão**: Comissaria, Transporte VIP, Reabastecimento, Atendimento VIP, Hangar, Taxa aeroportuária, Locação, Limpeza de QTU, Manutenção, Internet, Suporte técnico, Telefonia e Banco de dados. Itens novos podem ser salvos para as próximas solicitações.
- **Nº da OS**: digitado na criação (já vem sugerido o próximo número) e editável depois na OS e na planilha; o mesmo número pode ser usado em mais de uma OS.
- **Valor**: moeda Real (R$) ou Dólar (US$) por OS, valor unitário e valor da OS calculado por quantidade × valor unitário (pode ser alterado). Os totais somam cada moeda separadamente.
- **Contas**: perfis Operador, Administrador e Desenvolvedor. O desenvolvedor tem tudo do administrador e a conta fica protegida: só outro desenvolvedor a altera ou remove. Enquanto não houver nenhum desenvolvedor, um administrador pode criar o primeiro na aba Equipe.
- **Nova solicitação**: já mostra todos os serviços do checklist para marcar e permite informar a nota fiscal na criação.
- **Nota Fiscal**: aba com todas as notas, com os serviços solicitados, resumo de emitidas/sem nota e total, busca e filtro. O botão **+ Nova nota fiscal** emite notas avulsas, sem vínculo com uma OS, que podem ser editadas e excluídas.
- **Gerar Excel**: exporta um `.xlsx` com as abas *Serviços*, *Checklist* e *Notas fiscais* (usa [SheetJS](https://sheetjs.com/)).

## Banco de dados do site (Vercel + Neon)

No site da Vercel, a página usa a API `api/db.js`, que guarda tudo no Postgres do Neon (tabela `docs`). O login é conferido no servidor e cada aparelho recebe um token de sessão de 12 horas. As listas se atualizam sozinhas a cada 4 segundos, então uma OS criada num aparelho aparece nos outros.

A API lê a conexão da variável `DATABASE_URL` (criada pela integração Neon da Vercel), `POSTGRES_URL` ou `HANGAR_DB_URL`. Sem ela, o site mostra o aviso de que o banco não está ligado.

## Segurança

- **Senhas**: só o servidor transforma a senha em hash (PBKDF2-SHA256 com 600.000 iterações). Senhas antigas, mais fracas, são reforçadas no próximo login.
- **Tentativas de login**: depois de 5 senhas erradas no mesmo e-mail, ou 30 no mesmo IP, o login fica bloqueado por 15 minutos. Quando o e-mail não existe, a resposta demora o mesmo que uma senha errada, para não revelar quem tem conta.
- **Senha provisória**: 10 caracteres sorteados com o gerador seguro do navegador. Enquanto a pessoa não troca a provisória, a conta só consegue trocar a senha. A nova senha precisa ter pelo menos 8 caracteres e a troca exige a senha atual.
- **Sessões**: trocar ou resetar a senha derruba as sessões abertas daquela conta, e remover a conta derruba todas.
- **Cabeçalhos de segurança** (`vercel.json`): CSP, proteção contra o site ser aberto dentro de outro (clickjacking), HSTS, `nosniff` e Permissions-Policy.

### Variáveis da Vercel

- `DATABASE_URL`: conexão com o banco Neon. Já configurada pela integração Neon da Vercel.
- `SESSION_SECRET`: um texto aleatório longo, que assina os tokens de sessão. Defina sempre.
- `HANGAR_ADMIN_EMAIL` e `HANGAR_ADMIN_SENHA`: usados só no **primeiro acesso**, quando o banco ainda não tem nenhuma conta. Neste site, que já tem contas, não são necessárias. Entrar com eles cria um administrador, que troca a senha na hora. A senha precisa ter pelo menos 10 caracteres. Depois de criar a conta, pode apagar as duas variáveis.

## Como usar

Abra o `index.html` no navegador.

Os dados ficam salvos quando a página roda como artefato no claude.ai, que oferece o banco de dados compartilhado. Aberta fora dele, a página entra em modo de demonstração: mostra o login (e-mail `demo@exemplo.com`, senha `demo1234`), começa vazia e permite testar tudo, inclusive gerar o Excel, mas as alterações não ficam salvas ao recarregar.
