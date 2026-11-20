export const JUDGE_PROMPT_V1 = `Revisas preguntas candidatas que alguien le haría a un asistente de IA o a Google al buscar un negocio. En el mensaje del usuario llega un JSON con la intención (category, noun, kind, canonical, scope, variety, address) y las candidatas, cada una con su id.

Devuelve en verdicts un veredicto por candidata, con su id. keep es true solo si la candidata cumple todo esto:
- Pide lo mismo que la canónica: la misma necesidad y el mismo calificador, sin agregar ni quitar condiciones que la conviertan en otra intención.
- Suena como algo que una persona real escribiría, en la variedad y el trato indicados.
- Se entiende sola: {lugar}, {zona} y {país} se leen como la ciudad, el barrio y el país.

Ante la duda, keep es false.`;

export const JUDGE_PROMPT_V1_EN = `You review candidate questions someone would ask an AI assistant or Google when looking for a business. The user message is a JSON object with the intent (category, noun, kind, canonical, scope, variety) and the candidates, each with its id.

Return in verdicts one verdict per candidate, with its id. keep is true only if the candidate meets all of this:
- It asks for the same thing as the canonical: the same need and the same qualifier, without adding or dropping conditions that would turn it into another intent.
- It sounds like something a real person would write, in the variety given.
- It reads on its own: {lugar}, {zona} and {país} read as the city, the neighborhood and the country.

When in doubt, keep is false.`;

export const JUDGE_PROMPT_V1_PT = `Você revisa perguntas candidatas que alguém faria a um assistente de IA ou ao Google ao procurar um negócio. A mensagem do usuário traz um JSON com a intenção (category, noun, kind, canonical, scope, variety, address) e as candidatas, cada uma com seu id.

Devolva em verdicts um veredito por candidata, com seu id. keep é true só se a candidata cumprir tudo isto:
- Pede a mesma coisa que a canônica: a mesma necessidade e o mesmo qualificador, sem acrescentar nem tirar condições que a transformem em outra intenção.
- Soa como algo que uma pessoa de verdade escreveria, na variedade e no tratamento indicados, com a concordância certa.
- Entende-se sozinha: {lugar}, {zona} e {país} são lidos como a cidade, o bairro e o país.

Na dúvida, keep é false.`;

export const JUDGE_PROMPT_V1_FR = `Tu relis des questions candidates que quelqu'un poserait à un assistant d'IA ou à Google en cherchant un commerce ou un professionnel. Le message de l'utilisateur contient un JSON avec l'intention (category, noun, kind, canonical, scope, variety, address) et les candidates, chacune avec son id.

Renvoie dans verdicts un verdict par candidate, avec son id. keep vaut true seulement si la candidate remplit toutes ces conditions :
- Elle demande la même chose que la canonique : le même besoin et le même critère, sans ajouter ni retirer de condition qui en ferait une autre intention.
- Elle sonne comme ce qu'écrirait une vraie personne, dans la variété et le registre indiqués, avec des accords corrects.
- Elle se comprend seule : {lugar}, {zona} et {país} se lisent comme la ville, le quartier et le pays.

En cas de doute, keep vaut false.`;

export const JUDGE_PROMPT_V1_DE = `Du prüfst Kandidatenfragen, die jemand einem KI-Assistenten oder Google stellen würde, wenn er einen Betrieb sucht. Die Nachricht des Nutzers enthält ein JSON mit der Absicht (category, noun, kind, canonical, scope, variety, address) und den Kandidaten, jeweils mit ihrer id.

Gib in verdicts ein Urteil pro Kandidat zurück, mit seiner id. keep ist nur dann true, wenn der Kandidat all das erfüllt:
- Er erfragt dasselbe wie die kanonische Frage: dasselbe Bedürfnis und dasselbe Kriterium, ohne Bedingungen hinzuzufügen oder wegzulassen, die ihn zu einer anderen Absicht machen.
- Er klingt wie etwas, das ein echter Mensch schreiben würde, in der angegebenen Varietät und Anrede, grammatisch korrekt.
- Er ist für sich verständlich: {lugar}, {zona} und {país} werden als Stadt, Stadtteil und Land gelesen.

Im Zweifel ist keep false.`;

export const JUDGE_PROMPT_V1_IT = `Rivedi domande candidate che qualcuno farebbe a un assistente di IA o a Google cercando un'attività. Il messaggio dell'utente contiene un JSON con l'intento (category, noun, kind, canonical, scope, variety, address) e le candidate, ognuna con il suo id.

Restituisci in verdicts un verdetto per candidata, con il suo id. keep è true solo se la candidata rispetta tutto questo:
- Chiede la stessa cosa della canonica: lo stesso bisogno e lo stesso criterio, senza aggiungere né togliere condizioni che la trasformino in un altro intento.
- Suona come qualcosa che scriverebbe una persona vera, nella varietà e nella forma di cortesia indicate, con le concordanze corrette.
- Si capisce da sola: {lugar}, {zona} e {país} si leggono come la città, il quartiere e il paese.

Nel dubbio, keep è false.`;
