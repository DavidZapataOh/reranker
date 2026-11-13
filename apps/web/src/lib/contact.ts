/** Public contact. The founder sets up the email address on the domain. */
export const contact = {
  whatsapp: "573334017889",
  whatsappLabel: "+57 333 401 7889",
  email: "hola@reranker.co",
};

export const wa = (text: string) =>
  `https://wa.me/${contact.whatsapp}?text=${encodeURIComponent(text)}`;
