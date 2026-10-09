import type { Messages } from './en';

/**
 * Português do Brasil. Same keys as `en.ts` (enforced by the `Messages` type and by
 * `pnpm check:i18n`). Written for engineers and tech managers: "você", and the English terms
 * Brazilian teams actually use (deploy, pipeline, template, CLI, API, state, drift).
 */
export const ptBR: Messages = {
  meta: {
    title: 'OrkStage: control plane multicloud e open source',
    description:
      'Descreva o ambiente uma vez, coloque cada recurso na nuvem certa, revise plano, políticas e custo e faça o deploy com OpenTofu. Open source.',
    ogImageAlt: 'OrkStage: comande cada ambiente da sua nuvem. Control plane multicloud e open source.',
    notFoundTitle: 'Página não encontrada',
    notFoundDescription: 'Este endereço não corresponde a nenhuma página de orkstage.io. A documentação e a página inicial levam a todo o conteúdo do site.',
  },
  og: {
    headline: 'Comande cada ambiente da sua nuvem.',
    subline: 'Control plane multicloud e open source. Template, plano, deploy e operação.',
    footer: 'AWS, Azure, OCI. Escala de verdade. Controle preciso.',
  },
  common: {
    skipToContent: 'Pular para o conteúdo',
    homeLabel: 'Página inicial do OrkStage',
    mainNav: 'Principal',
    footerNav: 'Rodapé',
    docs: 'Docs',
    api: 'API',
    github: 'GitHub',
    getStarted: 'Começar',
    docsLanguageNote: 'A documentação está em inglês.',
  },
  language: {
    label: 'Idioma',
    suggestion: 'Esta página também está disponível em português.',
    suggestionAction: 'Ler em português',
    dismiss: 'Fechar',
    suggestionRegion: 'Sugestão de idioma',
  },
  tags: {
    available: 'disponível',
    planned: 'planejado',
    preview: 'Preview',
    approximate: 'aproximado',
    cliPreview: 'CLI preview',
    status: 'Status',
  },
  hero: {
    eyebrow: 'Control plane multicloud e open source',
    title: 'Comande cada ambiente da sua nuvem.',
    lead: 'Descreva o ambiente uma vez: serviços, Postgres, cache, fila, storage, ingress e DNS. Associe cada recurso à conta e à região que fazem sentido para ele. Revise o plano, o resultado das políticas e uma estimativa do custo mensal. Depois o OrkStage aplica tudo com OpenTofu e continua de olho.',
    primary: 'Começar',
    secondary: 'Ver o código no GitHub',
    facts: {
      licenseLabel: 'Licença',
      licenseValue: 'AGPL-3.0',
      runsLabel: 'Hospedagem',
      runsValue: 'Sua infraestrutura',
      engineLabel: 'Engine',
      engineValue: 'OpenTofu',
    },
    terminalLabel: 'Sessão de terminal: ork scan, ork template push e ork deploy --wait',
    terminalNote: 'Saída resumida. Hoje você compila o CLI ork a partir do código; ainda não há binários assinados.',
  },
  how: {
    label: 'Como funciona',
    title: 'Template, plano, deploy e observação. Cada etapa deixa um artefato que você consegue ler.',
    intro: 'Nada chega à nuvem antes de alguém revisar o plano. O worker aplica exatamente o plano que você aprovou, recurso por recurso.',
    steps: {
      template: {
        title: 'Template',
        text: 'Um arquivo YAML descreve a intenção sem citar provedor: uma API com duas réplicas, um Postgres replicado entre zonas, um storage versionado. Os placement slots dizem quais nuvens cada parte pode usar. Você escreve uma vez e faz deploy quantas vezes quiser.',
        artifactLabel: 'Trecho de template',
      },
      plan: {
        title: 'Plano',
        text: 'O compilador resolve cada recurso para um serviço concreto da nuvem, define nome e tags, ordena o grafo de dependências e escolhe uma estratégia de conectividade para cada ligação. O plano sai agrupado por provedor, target e região.',
        artifactLabel: 'Plano de deploy em texto',
      },
      deploy: {
        title: 'Deploy',
        text: 'O OpenTofu executa o grafo de dependências de forma assíncrona, com um state separado para cada recurso. Ramos independentes rodam em paralelo e falhas transitórias são repetidas. Quando um recurso falha, só os recursos que dependem dele ficam de fora. Antes de alterar recursos que já existem, o worker roda um `tofu plan` de verdade, e um delete ou replace em produção espera aprovação.',
        artifactLabel: 'Eventos do deploy',
      },
      observe: {
        title: 'Observação',
        text: 'Os health checks se consolidam na instância e em uma status page privada. Quando um componente crítico falha, o OrkStage abre um incidente, avisa os responsáveis no console e por email e encerra o incidente quando a saúde volta.',
      },
    },
  },
  placement: {
    label: 'Placement multicloud',
    title: 'Coloque cada recurso onde ele faz mais sentido.',
    intro:
      'O placement é definido por recurso, e não por ambiente. Associe o slot `data` a uma subscription do Azure e o mesmo template vira multicloud. Associe todos os slots a uma conta AWS e ele volta a rodar em uma nuvem só. O template não muda.',
    topologyTitle: 'Topologia de uma instância distribuída entre AWS, Azure e OCI',
    topologyDescription:
      'O slot primary, na AWS, contém dns, ingress, api, worker, registry e network. O slot data, no Azure, contém o banco PostgreSQL. O slot storage, na OCI, contém o object storage. A api e o worker acessam o banco por TLS com allowlist de origem; a api acessa o storage por TLS.',
    linksTitle: 'Como dois recursos se conectam',
    linksIntro: 'O compilador escolhe a estratégia e mostra no plano. Nada é provisionado sem você ver.',
    strategies: {
      privateNetwork: 'Mesma conta e mesma região.',
      privatePeering: 'Mesmo provedor, conta ou região diferente. Há custo de peering.',
      publicTls: 'Entre nuvens, no modo `private-preferred`: TLS em um endpoint público, com a origem liberada em allowlist.',
      unsatisfiable: 'Entre nuvens, no modo `private-required`. O plano falha até você mudar o modo ou o placement.',
    },
    status:
      'O provisionamento na AWS é real (OpenTofu, validado com MiniStack). Azure e OCI rodam hoje em um simulador determinístico e aparecem marcados como simulados em todo lugar. Os adapters dessas nuvens estão no roadmap.',
  },
  trust: {
    label: 'Governança',
    title: 'Planos que você confere antes de qualquer recurso existir.',
    intro: 'Políticas, custo e aprovações fazem parte do plano, e não de uma reunião depois do fato. Templates customizados passam pelas mesmas verificações e não podem pular nenhuma.',
    policiesTitle: 'Políticas, com todos os resultados à vista',
    policiesNote: 'Também entram na verificação: templates marcados como fora de produção, limite de réplicas e orçamento mensal.',
    costTitle: 'Estimativa de custo',
    costNote: 'Preços de lista de um catálogo estático, sob demanda, por mês. É uma estimativa, nunca uma fatura.',
    costCaption: 'Custo mensal aproximado por recurso na instância multicloud de referência',
    costResource: 'recurso',
    costPlacedOn: 'onde roda',
    costPerMonth: 'USD/mês',
    costTotal: 'total aproximado',
    approvalsTitle: 'Aprovação onde ela importa',
    approvalsText:
      'Mudanças em produção que apagam, substituem ou mexem em um banco de dados param em `AWAITING_APPROVAL`. O worker também lê o plano real do provedor, então uma substituição que o diff da plataforma não enxerga também pede aprovação. O resto segue, e o registro explica por que a aprovação não foi necessária.',
    auditTitle: 'Um audit log que ninguém edita',
    auditText:
      'Cada mudança vira um evento de auditoria com autor, correlation id e diff. Ações feitas com uma API key identificam a chave. Um trigger no Postgres rejeita updates e deletes na tabela, então o histórico fica exatamente como aconteceu.',
  },
  operate: {
    label: 'Operação',
    title: 'Feito para quem fica de plantão.',
    intro: 'Do health check que falha até o email na caixa de entrada do responsável, cada elo da cadeia é automático e visível.',
    health: {
      title: 'Saúde',
      text: 'A cada ciclo, o estado real é lido de novo no provedor e a saúde dos componentes se consolida na instância. Um componente crítico derruba a instância; os outros só a degradam.',
    },
    incidents: {
      title: 'Incidentes',
      text: 'As regras de alerta ficam guardadas como dados. Elas abrem um incidente por recurso, com deduplicação e cooldown, e encerram o incidente quando a saúde volta.',
    },
    statusPage: {
      title: 'Status page',
      text: 'Cada tenant tem uma status page privada que liga os recursos aos componentes que seus clientes enxergam: API, workers, banco de dados.',
    },
    notifications: {
      title: 'Notificações',
      text: 'Owners e admins do tenant e a equipe da plataforma recebem avisos no console e por email. Webhooks assinados levam os mesmos eventos para os seus sistemas.',
      meta: 'console · email · webhooks',
    },
    drift:
      'Se alguém apagar um recurso direto no console do provedor, um probe ao vivo percebe que ele sumiu, a verificação falha na hora em vez de esperar, e o próximo deploy cria o recurso de novo.',
  },
  repo: {
    label: 'Do seu repositório',
    title: 'Comece pela infraestrutura que você já tem.',
    intro:
      'O scan engine lê Terraform e OpenTofu, CloudFormation e SAM, Kubernetes e Helm, Docker Compose, Dockerfiles e manifestos de pacotes. Ele propõe um template OrkStage e mostra a evidência de cada recurso. Importe o relatório pela API ou pelo console e revise o rascunho antes de publicar.',
    sessionLabel: 'Sessão de terminal: ork import',
    note: 'Seu código não sai da sua máquina: o CLI faz o scan localmente e envia só o relatório.',
    importTitle: 'Importação de IaC',
    importText:
      '`POST /imports` recebe um ScanReport ou arquivos que o servidor analisa com o mesmo engine, compilado para WebAssembly. Recursos sem mapeamento e avisos aparecem na lista, nunca escondidos.',
    integrationsTitle: 'API keys, webhooks, intake de CI',
    integrationsText:
      'Chaves com escopo que nunca passam do papel de quem as criou, webhooks assinados com HMAC e protegidos contra replay, e versões imutáveis de imagem publicadas pelo CI por digest.',
    cliTitle: 'O CLI ork',
    cliText:
      '`init`, `scan`, `template validate`, `push` e `diff`, `import`, `deploy --wait`, `status`, `logs` e `destroy`. Saída em JSON e exit codes estáveis para CI. Compile a partir do código até os binários assinados saírem.',
  },
  editions: {
    label: 'Open core',
    title: 'Open source no núcleo. Enterprise onde a organização precisa.',
    intro:
      'O Community é o control plane completo sob AGPL-3.0 e basta para rodar produção na AWS. O Enterprise adiciona recursos para organizações grandes e para compliance sob licença comercial, ativados por uma chave de licença que funciona offline. Mesmo código, mesmas imagens.',
    caption: 'Comparação entre as edições Community e Enterprise',
    area: 'Área',
    community: 'Community',
    communityNote: 'AGPL-3.0, gratuito',
    enterprise: 'Enterprise',
    enterpriseNote: 'comercial, `ee/`',
    rows: {
      controlPlane: {
        area: 'Control plane',
        community: 'Templates, builder visual, placement, planos e políticas, estimativa de custo, deploys, saúde, incidentes, status pages, notificações',
        enterprisePlanned: 'Pacotes de políticas e criação de políticas próprias',
      },
      provisioning: {
        area: 'Provisionamento',
        community: 'AWS via OpenTofu, Azure e OCI simulados, grafo de dependências, retries, sinalização de drift',
        enterprisePlanned: 'Provisionamento de conectividade privada (VPN, interconnect)',
      },
      identity: {
        area: 'Identidade',
        community: 'Dev login, OIDC (Microsoft Entra; Google e GitLab por configuração)',
        enterprisePlanned: 'SSO com SAML 2.0 e provisionamento SCIM',
      },
      governance: {
        area: 'Governança',
        community: 'Sete papéis nativos, aprovação para mudanças de alto risco em produção, audit log que só aceita inserções',
        enterpriseAvailable: 'Exportação do audit log (NDJSON, CSV)',
        enterprisePlanned: 'Papéis customizados, aprovações em várias etapas, políticas de retenção',
      },
      organizations: {
        area: 'Organizações',
        community: 'Uma organização, vários tenants',
        enterprisePlanned: 'Várias organizações, status pages com a sua marca',
      },
      integrations: {
        area: 'Integrações',
        community: 'API keys, webhooks, intake de CI, importação de IaC, CLI ork (preview)',
        enterprisePlanned: 'Gestão de mudanças com ServiceNow ou Jira, alertas no PagerDuty ou Opsgenie',
      },
      support: {
        area: 'Suporte',
        community: 'GitHub Discussions',
        enterprisePlanned: 'Suporte prioritário com SLA',
      },
    },
    compare: 'Ver a comparação completa entre as edições',
    contact: 'Fale com a gente sobre o Enterprise',
  },
  selfHost: {
    label: 'Na sua infraestrutura',
    title: 'A plataforma inteira com um comando do Compose.',
    intro: 'Você só precisa de Docker. O arquivo do Compose sobe a API, o worker, o console, Postgres, Redis, Mailpit, a imagem do runner OpenTofu e o MiniStack para simular a AWS localmente.',
    windowMeta: 'avaliação local',
    commandLabel: 'Comando do Docker Compose',
    note: 'Esta stack roda em modo de desenvolvimento, com o dev login e o socket do Docker montado. Ela serve para avaliar o OrkStage na sua máquina, não para produção.',
    cta: 'Ler o quickstart',
  },
  footer: {
    tagline: 'Comande cada ambiente da sua nuvem. Escala de verdade. Controle preciso.',
    product: 'Produto',
    documentation: 'Documentação',
    quickstart: 'Quickstart',
    apiReference: 'Referência da API',
    project: 'Projeto',
    license: 'Licença (AGPL-3.0)',
    security: 'Segurança',
    company: 'Empresa',
    enterprise: 'Enterprise',
    contact: 'Contato',
    legal:
      'O OrkStage é open source sob a GNU AGPL-3.0. Os diretórios chamados `ee/` ficam sob a OrkStage Enterprise License. OrkStage e o logo do OrkStage são marcas do projeto OrkStage.',
  },
  notFound: {
    title: 'Esta página não existe.',
    text: 'A página mudou de endereço ou nunca existiu. Comece pela documentação (em inglês) ou pela página inicial.',
    docs: 'Ler a documentação',
    home: 'Ir para a página inicial',
  },
};
