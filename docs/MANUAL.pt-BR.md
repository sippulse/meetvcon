# SipPulse Meet Capture: manual do usuário

Para quem está na reunião. Se você é o administrador que vai distribuir a
extensão na empresa, leia o [INSTALL.md](../INSTALL.md).

---

## 1. O que a extensão faz, em um parágrafo

Enquanto você está em uma reunião do Google Meet, a extensão escreve a
transcrição com o nome de quem está falando. Quando a chamada termina, ela
escreve o relatório da reunião, com o resumo, o que foi decidido, quem se
comprometeu com o quê e para quando, os números citados, e os riscos em
aberto. O relatório e a transcrição são armazenados no vCon store da empresa e
enviados para o seu e-mail. Nenhum áudio é guardado em lugar nenhum.

**Antes de capturar qualquer coisa, avise os outros participantes.** A
extensão te dá a ferramenta, não a permissão. A política da empresa e a lei
continuam valendo.

---

## 2. Primeira vez, uma vez por computador

1. **Abra a página de opções.** Clique no ícone da SipPulse na barra do
   Chrome e depois em **Settings**.
2. **Leia o aviso e clique em "I understand, enable capture".** Nada é
   capturado antes disso.
3. **Olhe o cartão Connection.** Se Configuration diz *Ready*, o seu
   administrador já enviou as keys. Se aparecer uma lista de valores faltando,
   preencha no cartão Settings ou peça ao TI.
4. **Conceda o acesso aos servidores, se pedirem.** O Chrome só deixa a
   extensão alcançar os servidores que você aprova, e só a partir de um
   clique. Se aparecer uma linha dizendo que o acesso não foi liberado, clique
   em **Allow access**.
5. **Clique em "Test connections".** O vCon store, a transcrição e a SipPulse
   AI devem responder OK. A TypeSafe também, se a sua empresa usa.
6. **Libere o microfone uma vez.** Na primeira vez que você iniciar a
   transcrição ao vivo, abre uma aba pedindo acesso ao microfone. Libere,
   volte ao Meet e inicie de novo. O Chrome lembra.

---

## 3. Durante a reunião

### Abra o painel

Clique no ícone da SipPulse e depois em **Open the meeting panel**. O painel
abre no lado direito do navegador, ao lado da chamada, e continua lá mesmo
quando você troca de aba. Também dá para abrir pelo menu de painel lateral do
próprio Chrome, na barra de ferramentas.

Nada é desenhado por cima da página do Meet. O painel é a interface.

Se o seu administrador definiu a fonte da transcrição como **legendas do
Google**, não há botão para apertar: a extensão liga as legendas, lê o que
elas escrevem e gera o relatório no fim. O resto desta seção vale para o
padrão, em que a SipPulse AI transcreve o áudio da chamada.

### Inicie a transcrição ao vivo

Clique em **Start live transcription** no painel. A linha de status fica
vermelha e diz *Live transcription on (tab audio + microphone)*.

Enquanto você não clicar, a extensão só lê as legendas do próprio Google, e
apenas se você as tiver ligado. Essa rede de segurança não separa a sua voz
pelo microfone e não gera notas de IA. A extensão nunca liga as legendas por
você, então se você deixar o CC desligado e não iniciar a transcrição ao vivo,
nada é capturado.

### As três abas

- **Transcript.** Cada linha com o nome de quem falou e o tempo desde o começo
  da chamada. Quando a empresa usa a TypeSafe, as linhas ganham marcadores
  como *question*, *commitment*, *objection* ou *buying signal*. O texto em
  itálico cinza é fala ainda em reconhecimento.
- **Notes.** O relatório da reunião. Por padrão ele é escrito uma vez, no fim
  da chamada, então durante a reunião essa aba avisa isso. Se o seu
  administrador configurou `AnalysisMode` como `live`, as notas aparecem por
  volta de um minuto e se atualizam a cada minuto.
- **Speakers.** Tempo de fala por pessoa, com barra do percentual da conversa
  e o rótulo de sentimento quando a classificação está ligada.

### Pausar

**Stop live transcription** encerra o streaming de áudio e mantém tudo que já
foi escrito. O botão vira **Resume live transcription**, e ao iniciar de novo
a transcrição continua a mesma, na mesma linha do tempo. O que foi dito
enquanto estava desligado simplesmente não entra na transcrição.

### Encerrar uma chamada que não deve ser registrada

Clique em **Stop and discard this call**. A captura para, os dados salvos
daquela chamada são apagados, e nada é entregue. Essa decisão vale mesmo que
você recarregue a aba ou entre de novo.

---

## 4. Depois da chamada

Saia da reunião e deixe o Chrome aberto por cerca de um minuto. O popup passa
por *Preparing the meeting report* e depois *Delivered*.

Você recebe:

- **Um e-mail** com a manchete, o resumo, os itens de ação, o próximo passo,
  as decisões, os números, os riscos, os tópicos, o tempo de fala e a
  transcrição.
- **Um vCon no store da empresa**, que o CRM indexa no cliente.
- **Uma cópia local**, no popup em *Last transcript*. Baixe como `.md` para
  ler ou colar, ou como `.vcon` para o documento bruto.

Se a entrega falhar, o popup mostra uma **Outbox**. Ela tenta de novo sozinha.
Você também pode clicar em **Retry**, em **Download** para pegar o relatório,
ou em **Discard** para descartar o item.

---

## 5. Quando algo parece errado

### A transcrição está ruim, ou sem nomes

Você provavelmente está na rede de segurança das legendas do Google. Verifique
qual fonte foi usada:

1. No popup, olhe *Last transcript*. Ele diz *live transcript* ou *Google
   captions copy*.
2. Para a resposta definitiva, baixe o `.md`. O cabeçalho traz uma linha:

   | Valor | O que aconteceu |
   |---|---|
   | `sippulse_ai_live` | A transcrição ao vivo funcionou |
   | `sippulse_ai_live_recovered` | Funcionou, mas o gravador morreu e a transcrição foi remontada do que tinha sido salvo |
   | `google_captions_fallback` | A transcrição ao vivo começou e não produziu nada aproveitável |
   | `google_captions` | A transcrição ao vivo nunca foi iniciada |

Se aparecer `google_captions`, você não clicou em **Start live
transcription**. Se aparecer `google_captions_fallback`, confira o acesso aos
servidores e a key na página de opções, e use **Test connections**.

### O painel diz "Open a Google Meet to begin"

A aba ativa não é uma chamada do Meet. Volte para a aba do Meet; o painel
acompanha em até dois segundos.

### O painel diz que a captura não está configurada, ou pede consentimento

A linha de status nomeia a peça que falta. Clique no botão abaixo dela para ir
direto à página de opções.

### "Reconnecting to live transcription"

A rede caiu. A reconexão é automática e a transcrição volta com os horários
certos. Se ficar em amarelo por mais de um minuto, pare e inicie a transcrição
ao vivo de novo.

### O relatório não chegou por e-mail

Olhe o popup primeiro: se ele diz *Delivered*, a extensão fez a parte dela e o
e-mail é responsabilidade do CRM. Fale com o TI informando o assunto e o
horário da reunião.

---

## 6. O que sai do seu navegador

| O quê | Para onde vai | Quando |
|---|---|---|
| Áudio da reunião | SipPulse AI, para transcrição | Enquanto a transcrição está ligada. Nunca é armazenado. |
| Texto da transcrição | SipPulse AI, para escrever o relatório | No fim da chamada, ou a cada minuto no modo live |
| Cada linha da transcrição | TypeSafe, para intenção e sentimento | Só se a sua empresa configurou |
| O vCon final | O vCon store da empresa, e depois sua caixa de entrada | No fim da chamada |

Dúvidas sobre privacidade: security@sippulse.com

---

*SipPulse Meet Capture 1.0.0*
