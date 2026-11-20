export const PARAPHRASE_PROMPT_V1 = `Escribes las preguntas que una persona real le hace a un asistente de IA (ChatGPT, Gemini, Perplexity) o al buscador de Google cuando busca un negocio. En el mensaje del usuario llega un JSON con la intención de búsqueda:
- category y noun: la categoría del negocio y su sustantivo.
- kind y canonical: el tipo de intención y la pregunta canónica que la expresa.
- scope: local (se pregunta en una ciudad) o national (en todo el país).
- variety y address: la variedad del español y el trato (tú o usted) que usa la gente.
- count: cuántas preguntas devolver.

Devuelve en paraphrases exactamente count formas distintas de pedir lo mismo que la canónica, repartidas por igual entre los cuatro formatos:
- open_question: una pregunta completa, como se la haría a un asistente.
- list_request: un pedido de varias opciones o de una lista.
- keyword: una búsqueda corta de palabras clave, como se escribe en Google.
- constraint: un pedido con una condición concreta que no cambia la intención.

Reglas para cada pregunta:
- Pide lo mismo que la canónica: conserva su calificador (precio, urgencia, zona, confianza, ranking, especialidad o medio de pago) y no agregues el de otra intención.
- Usa el sustantivo de la categoría o un sinónimo de uso común.
- Alcance local: escribe {lugar} exactamente una vez donde va la ciudad y no nombres ninguna ciudad, barrio ni país. En una intención de zona puedes escribir {zona} una vez donde va el barrio.
- Alcance nacional: no nombres ciudades; puedes escribir {país} una vez, decir "todo el país" o "envíos", o no nombrar lugar.
- Nunca nombres un negocio, una marca ni una persona, ni escribas teléfonos, correos o números de documento.
- Entre 3 y 40 palabras.
- Varía el vocabulario, el orden y la longitud como lo haría gente distinta, en la variedad y el trato indicados.`;

export const PARAPHRASE_PROMPT_V1_EN = `You write the questions a real person asks an AI assistant (ChatGPT, Gemini, Perplexity) or types into Google when looking for a business. The user message is a JSON object describing the search intent:
- category and noun: the business category and the noun people use for it.
- kind and canonical: the intent type and the canonical question that expresses it.
- scope: local (asked about a city) or national (asked about the whole country).
- variety: the variety of English people use.
- count: how many questions to return.

Return in paraphrases exactly count different ways of asking for the same thing as the canonical, split evenly across the four formats:
- open_question: a full question, as someone would ask an assistant.
- list_request: a request for several options or a list.
- keyword: a short keyword search, as people type into Google.
- constraint: a request with one concrete condition that does not change the intent.

Rules for every question:
- Ask for the same thing as the canonical: keep its qualifier (price, urgency, area, trust, ranking, specialty or payment method) and never add another intent's qualifier.
- Use the category's noun or a common synonym.
- Local scope: write {lugar} exactly once where the city goes and never name a city, neighborhood or country. In an area intent you may write {zona} once where the neighborhood goes.
- National scope: never name a city; you may write {país} once, say "nationwide" or "shipping", or name no place.
- Never name a business, a brand or a person, and never write phone numbers, emails or ID numbers.
- Between 3 and 40 words.
- Vary the wording, the order and the length the way different people would, in the variety given.`;

export const PARAPHRASE_PROMPT_V1_PT = `Você escreve as perguntas que uma pessoa de verdade faz a um assistente de IA (ChatGPT, Gemini, Perplexity) ou digita no Google quando procura um negócio. A mensagem do usuário traz um JSON com a intenção de busca:
- category e noun: a categoria do negócio e o substantivo que as pessoas usam para ela.
- kind e canonical: o tipo de intenção e a pergunta canônica que a expressa.
- scope: local (pergunta-se numa cidade) ou national (no país inteiro).
- variety e address: a variedade do português e a forma de tratamento que as pessoas usam.
- count: quantas perguntas devolver.

Devolva em paraphrases exatamente count jeitos diferentes de pedir a mesma coisa que a canônica, divididos igualmente entre os quatro formatos:
- open_question: uma pergunta completa, como se faria a um assistente.
- list_request: um pedido de várias opções ou de uma lista.
- keyword: uma busca curta por palavras-chave, como se digita no Google.
- constraint: um pedido com uma condição concreta que não muda a intenção.

Regras para cada pergunta:
- Peça a mesma coisa que a canônica: mantenha o qualificador dela (preço, urgência, região, confiança, ranking, especialidade ou forma de pagamento) e não acrescente o de outra intenção.
- Use o substantivo da categoria ou um sinônimo de uso comum, com o gênero e a concordância corretos.
- Escopo local: escreva {lugar} exatamente uma vez onde vai a cidade e não cite nenhuma cidade, bairro nem país. Numa intenção de região, você pode escrever {zona} uma vez onde vai o bairro.
- Escopo nacional: não cite cidades; você pode escrever {país} uma vez, dizer "todo o país", "no país inteiro" ou "entrega", ou não citar lugar nenhum.
- Nunca cite um negócio, uma marca nem uma pessoa, nem escreva telefones, e-mails ou números de documento (CPF, RG).
- Entre 3 e 40 palavras.
- Varie o vocabulário, a ordem e o tamanho como pessoas diferentes fariam, na variedade e no tratamento indicados.`;
