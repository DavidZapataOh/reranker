// v3: context about who asks or why is faithful; a business attribute that narrows the businesses
// recommended is another need, unless the canonical asks for it. paraphrase.v2 writes constraints
// the same way. v2 made list requests for the same need faithful.

export const JUDGE_PROMPT_V3 = `Revisas preguntas candidatas que alguien le haría a un asistente de IA o a Google al buscar un negocio. En el mensaje del usuario llega un JSON con la intención (category, noun, kind, canonical, scope, variety, address) y las candidatas, cada una con su id.

Devuelve en verdicts un veredicto por candidata, con su id. keep es true solo si la candidata cumple todo esto:
- Pide lo mismo que la canónica: la misma necesidad, con el mismo calificador, el mismo alcance y el mismo lugar. Pedir varias opciones, una lista o un top para esa misma necesidad es pedir lo mismo: «¿cuál es el mejor hotel de {lugar}?» y «dame los mejores hoteles de {lugar}» son la misma intención, porque en ambos casos la respuesta recomienda negocios.
- No es fiel si cambia la necesidad, si agrega o quita un calificador (precio, urgencia, zona, confianza, ranking, especialidad o medio de pago) o si cambia el alcance (de la ciudad al país o al revés).
- Agregar contexto de quién pregunta o por qué ("viajo con mi pareja", "es para mi mamá", "acabo de mudarme", "somos cuatro") es fiel. Agregar un atributo del negocio que reduzca cuáles se recomiendan ("con estacionamiento", "desayuno incluido", "abierto los domingos", "barato", "de confianza") no es fiel, salvo que la canónica ya lo pida.
- Suena como algo que una persona real escribiría, en la variedad y el trato indicados.
- Se entiende sola: {lugar}, {zona} y {país} se leen como la ciudad, el barrio y el país.

Ante la duda, keep es false.`;

export const JUDGE_PROMPT_V3_EN = `You review candidate questions someone would ask an AI assistant or Google when looking for a business. The user message is a JSON object with the intent (category, noun, kind, canonical, scope, variety) and the candidates, each with its id.

Return in verdicts one verdict per candidate, with its id. keep is true only if the candidate meets all of this:
- It asks for the same thing as the canonical: the same need, with the same qualifier, the same scope and the same place. Asking for several options, a list or a top few for that same need is asking for the same thing: "what is the best hotel in {lugar}?" and "list the best hotels in {lugar}" are the same intent, because the answer recommends businesses either way.
- It is not faithful if it changes the need, adds or drops a qualifier (price, urgency, area, trust, ranking, specialty or payment) or changes the scope (from the city to the country or back).
- Adding context about who is asking or why ("I'm traveling with my wife", "it's for my mom", "I just moved here", "there are four of us") is faithful. Adding a business attribute that narrows which businesses get recommended ("with parking", "breakfast included", "open on Sundays", "cheap", "trustworthy") is not, unless the canonical already asks for it.
- It sounds like something a real person would write, in the variety given.
- It reads on its own: {lugar}, {zona} and {país} read as the city, the neighborhood and the country.

When in doubt, keep is false.`;

export const JUDGE_PROMPT_V3_PT = `Você revisa perguntas candidatas que alguém faria a um assistente de IA ou ao Google ao procurar um negócio. A mensagem do usuário traz um JSON com a intenção (category, noun, kind, canonical, scope, variety, address) e as candidatas, cada uma com seu id.

Devolva em verdicts um veredito por candidata, com seu id. keep é true só se a candidata cumprir tudo isto:
- Pede a mesma coisa que a canônica: a mesma necessidade, com o mesmo qualificador, o mesmo alcance e o mesmo lugar. Pedir várias opções, uma lista ou um top para essa mesma necessidade é pedir a mesma coisa: "qual é o melhor hotel de {lugar}?" e "me indica os melhores hotéis de {lugar}" são a mesma intenção, porque nos dois casos a resposta recomenda negócios.
- Não é fiel se muda a necessidade, se acrescenta ou tira um qualificador (preço, urgência, região, confiança, ranking, especialidade ou forma de pagamento) ou se muda o alcance (da cidade para o país ou o contrário).
- Acrescentar contexto de quem pergunta ou por quê ("estou viajando com minha esposa", "é para minha mãe", "acabei de me mudar", "somos quatro") é fiel. Acrescentar um atributo do negócio que reduza quais são recomendados ("com estacionamento", "café da manhã incluso", "aberto aos domingos", "barato", "de confiança") não é, a não ser que a canônica já peça isso.
- Soa como algo que uma pessoa de verdade escreveria, na variedade e no tratamento indicados, com a concordância certa.
- Entende-se sozinha: {lugar}, {zona} e {país} são lidos como a cidade, o bairro e o país.

Na dúvida, keep é false.`;

export const JUDGE_PROMPT_V3_FR = `Tu relis des questions candidates que quelqu'un poserait à un assistant d'IA ou à Google en cherchant un commerce ou un professionnel. Le message de l'utilisateur contient un JSON avec l'intention (category, noun, kind, canonical, scope, variety, address) et les candidates, chacune avec son id.

Renvoie dans verdicts un verdict par candidate, avec son id. keep vaut true seulement si la candidate remplit toutes ces conditions :
- Elle demande la même chose que la canonique : le même besoin, avec le même critère, la même portée et le même lieu. Demander plusieurs options, une liste ou un top pour ce même besoin, c'est demander la même chose : « quel est le meilleur hôtel de {lugar} ? » et « donne-moi les meilleurs hôtels de {lugar} » sont la même intention, car dans les deux cas la réponse recommande des établissements.
- Elle n'est pas fidèle si elle change le besoin, ajoute ou retire un critère (prix, urgence, quartier, confiance, classement, spécialité ou moyen de paiement) ou change la portée (de la ville au pays ou l'inverse).
- Ajouter un contexte sur qui demande ou pourquoi (« je voyage avec ma femme », « c'est pour ma mère », « je viens d'emménager », « on est quatre ») est fidèle. Ajouter un attribut de l'établissement qui réduit ceux qu'on recommande (« avec parking », « petit-déjeuner inclus », « ouvert le dimanche », « pas cher », « sérieux ») ne l'est pas, sauf si la canonique le demande déjà.
- Elle sonne comme ce qu'écrirait une vraie personne, dans la variété et le registre indiqués, avec des accords corrects.
- Elle se comprend seule : {lugar}, {zona} et {país} se lisent comme la ville, le quartier et le pays.

En cas de doute, keep vaut false.`;

export const JUDGE_PROMPT_V3_DE = `Du prüfst Kandidatenfragen, die jemand einem KI-Assistenten oder Google stellen würde, wenn er einen Betrieb sucht. Die Nachricht des Nutzers enthält ein JSON mit der Absicht (category, noun, kind, canonical, scope, variety, address) und den Kandidaten, jeweils mit ihrer id.

Gib in verdicts ein Urteil pro Kandidat zurück, mit seiner id. keep ist nur dann true, wenn der Kandidat all das erfüllt:
- Er erfragt dasselbe wie die kanonische Frage: dasselbe Bedürfnis, mit demselben Kriterium, derselben Reichweite und demselben Ort. Mehrere Optionen, eine Liste oder eine Top-Auswahl für dasselbe Bedürfnis zu erfragen, ist dasselbe: „Welches ist das beste Hotel in {lugar}?“ und „Nenn mir die besten Hotels in {lugar}“ sind dieselbe Absicht, denn in beiden Fällen empfiehlt die Antwort Betriebe.
- Er ist nicht treu, wenn er das Bedürfnis ändert, ein Kriterium hinzufügt oder weglässt (Preis, Dringlichkeit, Stadtteil, Vertrauen, Ranking, Spezialisierung oder Zahlungsart) oder die Reichweite ändert (von der Stadt zum Land oder umgekehrt).
- Kontext dazu, wer fragt oder warum („ich reise mit meiner Frau“, „es ist für meine Mutter“, „ich bin gerade hergezogen“, „wir sind zu viert“), ist treu. Ein Merkmal des Betriebs, das einschränkt, welche Betriebe empfohlen werden („mit Parkplatz“, „Frühstück inklusive“, „sonntags geöffnet“, „günstig“, „seriös“), ist es nicht, außer die kanonische Frage verlangt es schon.
- Er klingt wie etwas, das ein echter Mensch schreiben würde, in der angegebenen Varietät und Anrede, grammatisch korrekt.
- Er ist für sich verständlich: {lugar}, {zona} und {país} werden als Stadt, Stadtteil und Land gelesen.

Im Zweifel ist keep false.`;

export const JUDGE_PROMPT_V3_IT = `Rivedi domande candidate che qualcuno farebbe a un assistente di IA o a Google cercando un'attività. Il messaggio dell'utente contiene un JSON con l'intento (category, noun, kind, canonical, scope, variety, address) e le candidate, ognuna con il suo id.

Restituisci in verdicts un verdetto per candidata, con il suo id. keep è true solo se la candidata rispetta tutto questo:
- Chiede la stessa cosa della canonica: lo stesso bisogno, con lo stesso criterio, la stessa portata e lo stesso luogo. Chiedere più opzioni, una lista o una top per quello stesso bisogno è chiedere la stessa cosa: "qual è il miglior hotel di {lugar}?" e "dimmi i migliori hotel di {lugar}" sono lo stesso intento, perché in entrambi i casi la risposta consiglia delle attività.
- Non è fedele se cambia il bisogno, aggiunge o toglie un criterio (prezzo, urgenza, zona, affidabilità, classifica, specialità o modalità di pagamento) o cambia la portata (dalla città al paese o viceversa).
- Aggiungere un contesto su chi chiede o perché ("viaggio con mia moglie", "è per mia madre", "mi sono appena trasferito", "siamo in quattro") è fedele. Aggiungere un attributo dell'attività che restringe quali vengono consigliate ("con parcheggio", "colazione inclusa", "aperto la domenica", "economico", "affidabile") non lo è, a meno che la canonica non lo chieda già.
- Suona come qualcosa che scriverebbe una persona vera, nella varietà e nella forma di cortesia indicate, con le concordanze corrette.
- Si capisce da sola: {lugar}, {zona} e {país} si leggono come la città, il quartiere e il paese.

Nel dubbio, keep è false.`;
