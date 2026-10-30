# Controle de Serviços Aéreos

Página para registrar ordens de serviço em aeroportos.

- **Planilha**: todas as OS em uma tabela editável (data, aeroporto, discriminação, checklist, status, nota fiscal e valor), com busca, filtro por status e total.
- **OS**: cada ordem de serviço com data, local, prestador, valor, discriminação e checklist com OK.
- **Checklist padrão**: Comissaria, Transporte VIP, Reabastecimento, Atendimento VIP, Hangar, Taxa aeroportuária, Locação, Limpeza de QTU, Manutenção, Internet, Suporte técnico, Telefonia e Banco de dados. Itens novos podem ser salvos para as próximas solicitações.
- **Nova solicitação**: já mostra todos os serviços do checklist para marcar e permite informar a nota fiscal na criação.
- **Nota Fiscal**: aba com todas as notas, com os serviços solicitados, resumo de emitidas/sem nota e total, busca e filtro. O botão **+ Nova nota fiscal** emite notas avulsas, sem vínculo com uma OS, que podem ser editadas e excluídas.
- **Gerar Excel**: exporta um `.xlsx` com as abas *Serviços*, *Checklist* e *Notas fiscais* (usa [SheetJS](https://sheetjs.com/)).

## Como usar

Abra o `index.html` no navegador.

Os dados ficam salvos quando a página roda como artefato no claude.ai, que oferece o banco de dados compartilhado. Aberta fora dele, a página entra em modo de demonstração: começa vazia e permite testar tudo, inclusive gerar o Excel, mas as alterações não ficam salvas ao recarregar.
