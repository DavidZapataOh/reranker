import type { EntityKind, ExtractedMention } from "@reranker/schema/measurement";
import { normalizeName } from "./normalize";
import { assignOrdinals } from "./quote";

export interface PlatformEntry {
  slug: string;
  names: readonly string[];
  /** Registrable hosts, optionally with a path prefix ("google.com/maps"). */
  domains: readonly string[];
  kind: "platform" | "directory_or_media";
}

export const PLATFORMS: readonly PlatformEntry[] = [
  {
    slug: "booking",
    names: ["Booking", "Booking.com"],
    domains: ["booking.com"],
    kind: "platform",
  },
  {
    slug: "airbnb",
    names: ["Airbnb", "Air BnB"],
    domains: [
      "airbnb.com",
      "airbnb.com.co",
      "airbnb.mx",
      "airbnb.es",
      "airbnb.com.ar",
      "airbnb.cl",
      "airbnb.com.pe",
      "airbnb.com.ec",
      "airbnb.co.cr",
      "airbnb.com.br",
      "airbnb.pt",
      "airbnb.co.uk",
      "airbnb.ca",
      "airbnb.fr",
      "airbnb.de",
      "airbnb.it",
    ],
    kind: "platform",
  },
  {
    slug: "doctoralia",
    names: ["Doctoralia"],
    domains: [
      "doctoralia.com",
      "doctoralia.co",
      "doctoralia.com.mx",
      "doctoralia.es",
      "doctoralia.cl",
      "doctoralia.pe",
      "doctoraliar.com",
      "doctoralia.com.br",
      "doctoralia.com.pt",
    ],
    kind: "platform",
  },
  {
    slug: "fincaraiz",
    names: ["Finca Raíz", "Fincaraíz"],
    domains: ["fincaraiz.com.co"],
    kind: "platform",
  },
  {
    slug: "metrocuadrado",
    names: ["Metro Cuadrado", "Metrocuadrado"],
    domains: ["metrocuadrado.com"],
    kind: "platform",
  },
  {
    slug: "ciencuadras",
    names: ["Ciencuadras", "Cien Cuadras"],
    domains: ["ciencuadras.com"],
    kind: "platform",
  },
  {
    slug: "tripadvisor",
    names: ["Tripadvisor", "Trip Advisor"],
    domains: [
      "tripadvisor.com",
      "tripadvisor.co",
      "tripadvisor.com.mx",
      "tripadvisor.es",
      "tripadvisor.cl",
      "tripadvisor.com.ar",
      "tripadvisor.com.pe",
      "tripadvisor.com.br",
      "tripadvisor.pt",
      "tripadvisor.co.uk",
      "tripadvisor.ca",
      "tripadvisor.fr",
      "tripadvisor.de",
      "tripadvisor.it",
    ],
    kind: "platform",
  },
  {
    slug: "expedia",
    names: ["Expedia"],
    domains: [
      "expedia.com",
      "expedia.mx",
      "expedia.es",
      "expedia.com.ar",
      "expedia.com.br",
      "expedia.co.uk",
      "expedia.ca",
      "expedia.fr",
      "expedia.de",
      "expedia.it",
    ],
    kind: "platform",
  },
  {
    slug: "google-maps",
    names: [
      "Google Maps",
      "Google Mapas",
      "Google Business Profile",
      "Google My Business",
      "Google Mi Negocio",
      "Perfil de Empresa de Google",
      "Perfil de Negocio de Google",
    ],
    domains: [
      "maps.google.com",
      "maps.app.goo.gl",
      "goo.gl/maps",
      "google.com/maps",
      "business.google.com",
      "g.page",
    ],
    kind: "platform",
  },
  {
    slug: "instagram",
    names: ["Instagram"],
    domains: ["instagram.com", "instagr.am"],
    kind: "platform",
  },
  {
    slug: "rappi",
    names: ["Rappi"],
    domains: [
      "rappi.com",
      "rappi.com.co",
      "rappi.com.mx",
      "rappi.cl",
      "rappi.com.ar",
      "rappi.com.pe",
      "rappi.com.ec",
      "rappi.com.uy",
      "rappi.co.cr",
      "rappi.com.br",
    ],
    kind: "directory_or_media",
  },
  {
    slug: "didi-food",
    names: ["DiDi Food"],
    domains: [
      "didi-food.com",
      "didiglobal.com/mx/food",
      "didiglobal.com/co/food",
      "didiglobal.com/pe/food",
      "didiglobal.com/cr/food",
    ],
    kind: "directory_or_media",
  },
  {
    slug: "facebook",
    names: ["Facebook", "Facebook Marketplace"],
    domains: ["facebook.com", "fb.com", "fb.me"],
    kind: "directory_or_media",
  },
  {
    slug: "tiktok",
    names: ["TikTok", "Tik Tok"],
    domains: ["tiktok.com"],
    kind: "directory_or_media",
  },
  {
    slug: "youtube",
    names: ["YouTube"],
    domains: ["youtube.com", "youtu.be"],
    kind: "directory_or_media",
  },
  { slug: "waze", names: ["Waze"], domains: ["waze.com"], kind: "directory_or_media" },

  // Names that are also common words or plausible business names ("Realtor", "Plusvalía",
  // "El Tenedor", "La Haus", "Urbania") are matched only in their dotted or joined form, and
  // their domains carry the rest: a business literally called that must stay a business.

  {
    slug: "idealista",
    names: ["Idealista"],
    domains: ["idealista.com", "idealista.pt", "idealista.it"],
    kind: "platform",
  },
  { slug: "fotocasa", names: ["Fotocasa"], domains: ["fotocasa.es"], kind: "platform" },
  { slug: "habitaclia", names: ["Habitaclia"], domains: ["habitaclia.com"], kind: "platform" },
  { slug: "pisos-com", names: ["Pisos.com"], domains: ["pisos.com"], kind: "platform" },
  {
    slug: "mitula",
    names: ["Mitula"],
    domains: [
      "mitula.com",
      "mitula.mx",
      "mitula.com.ar",
      "mitula.cl",
      "mitula.com.co",
      "mitula.ec",
    ],
    kind: "platform",
  },
  { slug: "inmuebles24", names: ["Inmuebles24"], domains: ["inmuebles24.com"], kind: "platform" },
  {
    slug: "vivanuncios",
    names: ["Vivanuncios"],
    domains: ["vivanuncios.com.mx"],
    kind: "platform",
  },
  { slug: "lamudi", names: ["Lamudi"], domains: ["lamudi.com.mx"], kind: "platform" },
  {
    slug: "propiedades-com",
    names: ["Propiedades.com"],
    domains: ["propiedades.com"],
    kind: "platform",
  },
  { slug: "la-haus", names: ["LaHaus", "LaHaus.com"], domains: ["lahaus.com"], kind: "platform" },
  {
    slug: "mudafy",
    names: ["Mudafy"],
    domains: ["mudafy.com.ar", "mudafy.com.mx"],
    kind: "platform",
  },
  { slug: "zonaprop", names: ["Zonaprop"], domains: ["zonaprop.com.ar"], kind: "platform" },
  { slug: "argenprop", names: ["Argenprop"], domains: ["argenprop.com"], kind: "platform" },
  {
    slug: "properati",
    names: ["Properati"],
    domains: ["properati.com.ar", "properati.com.co", "properati.com.ec", "properati.com.pe"],
    kind: "platform",
  },
  {
    slug: "portal-inmobiliario",
    names: ["Portal Inmobiliario", "PortalInmobiliario"],
    domains: ["portalinmobiliario.com"],
    kind: "platform",
  },
  { slug: "yapo", names: ["Yapo", "Yapo.cl"], domains: ["yapo.cl"], kind: "platform" },
  { slug: "toctoc", names: ["TocToc"], domains: ["toctoc.com"], kind: "platform" },
  { slug: "urbania", names: ["Urbania.pe"], domains: ["urbania.pe"], kind: "platform" },
  {
    slug: "adondevivir",
    names: ["Adondevivir", "A donde vivir"],
    domains: ["adondevivir.com"],
    kind: "platform",
  },
  {
    slug: "nexo-inmobiliario",
    names: ["Nexoinmobiliario", "Nexoinmobiliario.pe"],
    domains: ["nexoinmobiliario.pe"],
    kind: "platform",
  },
  { slug: "laencontre", names: ["Laencontre"], domains: ["laencontre.com.pe"], kind: "platform" },
  { slug: "plusvalia", names: ["Plusvalia.com"], domains: ["plusvalia.com"], kind: "platform" },
  {
    slug: "infocasas",
    names: ["InfoCasas"],
    domains: ["infocasas.com.uy", "infocasas.com.py", "infocasas.com.bo", "infocasas.com.pe"],
    kind: "platform",
  },
  { slug: "gallito", names: ["Gallito.com.uy"], domains: ["gallito.com.uy"], kind: "platform" },
  { slug: "encuentra24", names: ["Encuentra24"], domains: ["encuentra24.com"], kind: "platform" },
  { slug: "zillow", names: ["Zillow"], domains: ["zillow.com"], kind: "platform" },
  { slug: "realtor-com", names: ["Realtor.com"], domains: ["realtor.com"], kind: "platform" },
  { slug: "redfin", names: ["Redfin"], domains: ["redfin.com"], kind: "platform" },
  { slug: "trulia", names: ["Trulia"], domains: ["trulia.com"], kind: "platform" },
  { slug: "homes-com", names: ["Homes.com"], domains: ["homes.com"], kind: "platform" },
  {
    slug: "apartments-com",
    names: ["Apartments.com"],
    domains: ["apartments.com"],
    kind: "platform",
  },
  { slug: "rightmove", names: ["Rightmove"], domains: ["rightmove.co.uk"], kind: "platform" },
  { slug: "zoopla", names: ["Zoopla"], domains: ["zoopla.co.uk"], kind: "platform" },
  { slug: "seloger", names: ["SeLoger"], domains: ["seloger.com"], kind: "platform" },
  {
    slug: "immobilienscout24",
    names: ["ImmobilienScout24", "ImmoScout24"],
    domains: ["immobilienscout24.de"],
    kind: "platform",
  },
  {
    slug: "immobiliare-it",
    names: ["Immobiliare.it"],
    domains: ["immobiliare.it"],
    kind: "platform",
  },
  { slug: "imovirtual", names: ["Imovirtual"], domains: ["imovirtual.com"], kind: "platform" },
  {
    slug: "zap-imoveis",
    names: ["ZAP Imóveis", "Zap Imoveis"],
    domains: ["zapimoveis.com.br"],
    kind: "platform",
  },
  {
    slug: "vivareal",
    names: ["VivaReal", "Viva Real"],
    domains: ["vivareal.com.br"],
    kind: "platform",
  },
  {
    slug: "quintoandar",
    names: ["QuintoAndar"],
    domains: ["quintoandar.com.br"],
    kind: "platform",
  },

  {
    slug: "mercadolibre",
    names: ["Mercado Libre", "MercadoLibre", "Mercado Livre"],
    domains: [
      "mercadolibre.com",
      "mercadolibre.com.ar",
      "mercadolibre.com.mx",
      "mercadolibre.cl",
      "mercadolibre.com.co",
      "mercadolibre.com.pe",
      "mercadolibre.com.ec",
      "mercadolibre.com.uy",
      "mercadolibre.com.ve",
      "mercadolibre.com.bo",
      "mercadolibre.com.py",
      "mercadolibre.com.do",
      "mercadolibre.com.pa",
      "mercadolibre.com.gt",
      "mercadolibre.co.cr",
      "mercadolivre.com.br",
    ],
    kind: "platform",
  },
  {
    slug: "amazon",
    names: ["Amazon"],
    domains: [
      "amazon.com",
      "amazon.es",
      "amazon.com.mx",
      "amazon.com.br",
      "amazon.ca",
      "amazon.co.uk",
      "amazon.de",
      "amazon.fr",
      "amazon.it",
    ],
    kind: "platform",
  },
  { slug: "wallapop", names: ["Wallapop"], domains: ["wallapop.com"], kind: "platform" },
  { slug: "milanuncios", names: ["Milanuncios"], domains: ["milanuncios.com"], kind: "platform" },
  { slug: "olx", names: ["OLX"], domains: ["olx.com.br", "olx.pt"], kind: "platform" },
  { slug: "leboncoin", names: ["Leboncoin"], domains: ["leboncoin.fr"], kind: "platform" },
  { slug: "craigslist", names: ["Craigslist"], domains: ["craigslist.org"], kind: "platform" },

  // Delivery apps keep the kind Rappi and DiDi Food have.
  {
    slug: "pedidosya",
    names: ["PedidosYa", "Pedidos Ya"],
    domains: [
      "pedidosya.com",
      "pedidosya.com.ar",
      "pedidosya.cl",
      "pedidosya.com.uy",
      "pedidosya.com.pe",
      "pedidosya.com.ec",
      "pedidosya.com.bo",
      "pedidosya.com.py",
      "pedidosya.com.do",
      "pedidosya.com.ve",
      "pedidosya.com.pa",
      "pedidosya.com.gt",
      "pedidosya.cr",
    ],
    kind: "directory_or_media",
  },
  {
    slug: "uber-eats",
    names: ["Uber Eats", "UberEats"],
    domains: ["ubereats.com"],
    kind: "directory_or_media",
  },
  { slug: "glovo", names: ["Glovo"], domains: ["glovoapp.com"], kind: "directory_or_media" },
  {
    slug: "just-eat",
    names: ["Just Eat", "JustEat"],
    domains: [
      "just-eat.es",
      "just-eat.co.uk",
      "just-eat.ie",
      "just-eat.fr",
      "just-eat.ch",
      "justeat.it",
    ],
    kind: "directory_or_media",
  },
  {
    slug: "lieferando",
    names: ["Lieferando"],
    domains: ["lieferando.de", "lieferando.at"],
    kind: "directory_or_media",
  },
  {
    slug: "deliveroo",
    names: ["Deliveroo"],
    domains: ["deliveroo.co.uk", "deliveroo.fr", "deliveroo.it", "deliveroo.be", "deliveroo.ie"],
    kind: "directory_or_media",
  },
  {
    slug: "doordash",
    names: ["DoorDash", "Door Dash"],
    domains: ["doordash.com"],
    kind: "directory_or_media",
  },
  { slug: "grubhub", names: ["Grubhub"], domains: ["grubhub.com"], kind: "directory_or_media" },
  {
    slug: "seamless",
    names: ["Seamless.com"],
    domains: ["seamless.com"],
    kind: "directory_or_media",
  },
  {
    slug: "postmates",
    names: ["Postmates"],
    domains: ["postmates.com"],
    kind: "directory_or_media",
  },
  { slug: "ifood", names: ["iFood"], domains: ["ifood.com.br"], kind: "directory_or_media" },

  {
    slug: "thefork",
    names: ["TheFork", "ElTenedor", "LaFourchette"],
    domains: [
      "thefork.com",
      "thefork.es",
      "thefork.it",
      "thefork.fr",
      "thefork.pt",
      "thefork.co.uk",
      "thefork.de",
      "eltenedor.es",
    ],
    kind: "platform",
  },
  {
    slug: "opentable",
    names: ["OpenTable", "Open Table"],
    domains: [
      "opentable.com",
      "opentable.com.mx",
      "opentable.ca",
      "opentable.co.uk",
      "opentable.ie",
      "opentable.es",
      "opentable.de",
      "opentable.it",
      "opentable.fr",
    ],
    kind: "platform",
  },
  { slug: "resy", names: ["Resy"], domains: ["resy.com"], kind: "platform" },
  {
    slug: "michelin-guide",
    names: ["Guía Michelin", "Michelin Guide", "Guide Michelin", "Guida Michelin"],
    domains: ["guide.michelin.com"],
    kind: "directory_or_media",
  },
  {
    slug: "guia-repsol",
    names: ["Guía Repsol"],
    domains: ["guiarepsol.com"],
    kind: "directory_or_media",
  },
  {
    slug: "restaurant-guru",
    names: ["Restaurant Guru"],
    domains: ["restaurantguru.com"],
    kind: "directory_or_media",
  },

  {
    slug: "despegar",
    names: ["Despegar", "Despegar.com", "Decolar"],
    domains: [
      "despegar.com",
      "despegar.com.ar",
      "despegar.com.mx",
      "despegar.cl",
      "despegar.com.co",
      "despegar.com.pe",
      "despegar.com.ec",
      "despegar.com.uy",
      "despegar.com.bo",
      "despegar.com.py",
      "despegar.com.do",
      "despegar.com.pa",
      "despegar.com.gt",
      "despegar.co.cr",
      "decolar.com",
    ],
    kind: "platform",
  },
  {
    slug: "trivago",
    names: ["Trivago"],
    domains: [
      "trivago.com",
      "trivago.es",
      "trivago.com.mx",
      "trivago.com.ar",
      "trivago.cl",
      "trivago.com.co",
      "trivago.pe",
      "trivago.com.ec",
      "trivago.com.uy",
      "trivago.com.br",
      "trivago.pt",
      "trivago.co.uk",
      "trivago.ca",
      "trivago.fr",
      "trivago.de",
      "trivago.it",
    ],
    kind: "platform",
  },
  {
    slug: "kayak",
    names: ["Kayak", "Kayak.com"],
    domains: [
      "kayak.com",
      "kayak.es",
      "kayak.com.mx",
      "kayak.com.ar",
      "kayak.cl",
      "kayak.com.co",
      "kayak.com.pe",
      "kayak.com.ec",
      "kayak.com.uy",
      "kayak.com.br",
      "kayak.pt",
      "kayak.co.uk",
      "kayak.fr",
      "kayak.de",
      "kayak.it",
    ],
    kind: "platform",
  },
  {
    slug: "hotels-com",
    names: ["Hotels.com", "Hoteles.com"],
    domains: ["hotels.com", "hoteles.com"],
    kind: "platform",
  },
  { slug: "agoda", names: ["Agoda"], domains: ["agoda.com"], kind: "platform" },
  { slug: "vrbo", names: ["Vrbo"], domains: ["vrbo.com"], kind: "platform" },
  { slug: "hostelworld", names: ["Hostelworld"], domains: ["hostelworld.com"], kind: "platform" },
  {
    slug: "turismocity",
    names: ["Turismocity"],
    domains: ["turismocity.com.ar", "turismocity.cl"],
    kind: "platform",
  },

  {
    slug: "top-doctors",
    names: ["Top Doctors", "TopDoctors"],
    domains: [
      "topdoctors.es",
      "topdoctors.mx",
      "topdoctors.com.co",
      "topdoctors.cl",
      "topdoctors.com.ar",
      "topdoctors.com.br",
      "topdoctors.co.uk",
      "topdoctors.it",
    ],
    kind: "platform",
  },
  {
    slug: "doctoranytime",
    names: ["Doctoranytime", "Doctor Anytime"],
    domains: ["doctoranytime.mx", "doctoranytime.ec"],
    kind: "platform",
  },
  { slug: "miodottore", names: ["MioDottore"], domains: ["miodottore.it"], kind: "platform" },
  { slug: "jameda", names: ["Jameda"], domains: ["jameda.de"], kind: "platform" },
  {
    slug: "doctolib",
    names: ["Doctolib"],
    domains: ["doctolib.fr", "doctolib.de", "doctolib.it"],
    kind: "platform",
  },
  { slug: "zocdoc", names: ["Zocdoc"], domains: ["zocdoc.com"], kind: "platform" },
  {
    slug: "healthgrades",
    names: ["Healthgrades"],
    domains: ["healthgrades.com"],
    kind: "platform",
  },
  { slug: "opencare", names: ["Opencare"], domains: ["opencare.com"], kind: "platform" },
  { slug: "realself", names: ["RealSelf"], domains: ["realself.com"], kind: "platform" },
  { slug: "whatclinic", names: ["WhatClinic"], domains: ["whatclinic.com"], kind: "platform" },

  {
    slug: "habitissimo",
    names: ["Habitissimo"],
    domains: [
      "habitissimo.es",
      "habitissimo.com.mx",
      "habitissimo.cl",
      "habitissimo.pt",
      "habitissimo.it",
      "habitissimo.fr",
    ],
    kind: "platform",
  },
  {
    slug: "cronoshare",
    names: ["Cronoshare"],
    domains: [
      "cronoshare.com",
      "cronoshare.com.mx",
      "cronoshare.cl",
      "cronoshare.com.co",
      "cronoshare.com.br",
      "cronoshare.it",
      "cronoshare.de",
      "cronoshare.co.uk",
    ],
    kind: "platform",
  },
  {
    slug: "homify",
    names: ["Homify"],
    domains: [
      "homify.com",
      "homify.es",
      "homify.com.mx",
      "homify.com.ar",
      "homify.cl",
      "homify.com.co",
      "homify.pe",
    ],
    kind: "platform",
  },
  { slug: "zolvers", names: ["Zolvers"], domains: ["zolvers.com"], kind: "platform" },
  { slug: "fixalista", names: ["Fixalista"], domains: ["fixalista.com"], kind: "platform" },
  {
    slug: "interdomicilio",
    names: ["Interdomicilio"],
    domains: ["interdomicilio.com"],
    kind: "platform",
  },
  {
    slug: "angi",
    names: ["Angi", "Angie's List"],
    domains: ["angi.com", "angieslist.com"],
    kind: "platform",
  },
  { slug: "homeadvisor", names: ["HomeAdvisor"], domains: ["homeadvisor.com"], kind: "platform" },
  { slug: "thumbtack", names: ["Thumbtack"], domains: ["thumbtack.com"], kind: "platform" },
  { slug: "houzz", names: ["Houzz"], domains: ["houzz.com", "houzz.es"], kind: "platform" },
  { slug: "checkatrade", names: ["Checkatrade"], domains: ["checkatrade.com"], kind: "platform" },
  {
    slug: "trustatrader",
    names: ["TrustATrader"],
    domains: ["trustatrader.com"],
    kind: "platform",
  },
  { slug: "prontopro", names: ["ProntoPro"], domains: ["prontopro.it"], kind: "platform" },
  { slug: "instapro", names: ["Instapro"], domains: ["instapro.it"], kind: "platform" },
  { slug: "zaask", names: ["Zaask"], domains: ["zaask.pt"], kind: "platform" },
  { slug: "fixando", names: ["Fixando"], domains: ["fixando.pt"], kind: "platform" },
  { slug: "getninjas", names: ["GetNinjas"], domains: ["getninjas.com.br"], kind: "platform" },

  {
    slug: "treatwell",
    names: ["Treatwell"],
    domains: [
      "treatwell.com",
      "treatwell.es",
      "treatwell.co.uk",
      "treatwell.fr",
      "treatwell.it",
      "treatwell.de",
      "treatwell.pt",
    ],
    kind: "platform",
  },
  { slug: "fresha", names: ["Fresha"], domains: ["fresha.com"], kind: "platform" },
  { slug: "booksy", names: ["Booksy"], domains: ["booksy.com"], kind: "platform" },
  { slug: "agendapro", names: ["AgendaPro"], domains: ["agendapro.com"], kind: "platform" },
  { slug: "vagaro", names: ["Vagaro"], domains: ["vagaro.com"], kind: "platform" },
  { slug: "styleseat", names: ["StyleSeat"], domains: ["styleseat.com"], kind: "platform" },

  { slug: "lawzana", names: ["Lawzana"], domains: ["lawzana.com"], kind: "platform" },
  { slug: "avvo", names: ["Avvo"], domains: ["avvo.com"], kind: "platform" },
  { slug: "justia", names: ["Justia"], domains: ["justia.com"], kind: "platform" },
  { slug: "findlaw", names: ["FindLaw"], domains: ["findlaw.com"], kind: "platform" },
  { slug: "lawyers-com", names: ["Lawyers.com"], domains: ["lawyers.com"], kind: "platform" },
  {
    slug: "martindale",
    names: ["Martindale-Hubbell"],
    domains: ["martindale.com"],
    kind: "platform",
  },
  { slug: "abogado-com", names: ["Abogado.com"], domains: ["abogado.com"], kind: "platform" },
  {
    slug: "super-lawyers",
    names: ["Super Lawyers"],
    domains: ["superlawyers.com"],
    kind: "directory_or_media",
  },
  {
    slug: "chambers",
    names: ["Chambers and Partners", "Chambers & Partners"],
    domains: ["chambers.com"],
    kind: "directory_or_media",
  },
  {
    slug: "legal-500",
    names: ["Legal 500", "The Legal 500"],
    domains: ["legal500.com"],
    kind: "directory_or_media",
  },

  { slug: "emagister", names: ["Emagister"], domains: ["emagister.com"], kind: "platform" },
  {
    slug: "educaweb",
    names: ["Educaweb"],
    domains: ["educaweb.com", "educaweb.mx", "educaweb.com.co"],
    kind: "platform",
  },
  { slug: "coursera", names: ["Coursera"], domains: ["coursera.org"], kind: "platform" },
  { slug: "udemy", names: ["Udemy"], domains: ["udemy.com"], kind: "platform" },
  { slug: "edx", names: ["edX"], domains: ["edx.org"], kind: "platform" },
  {
    slug: "qs-rankings",
    names: ["QS World University Rankings", "QS Top Universities"],
    domains: ["topuniversities.com"],
    kind: "directory_or_media",
  },
  {
    slug: "times-higher-education",
    names: ["Times Higher Education"],
    domains: ["timeshighereducation.com"],
    kind: "directory_or_media",
  },

  { slug: "coches-net", names: ["Coches.net"], domains: ["coches.net"], kind: "platform" },
  { slug: "autocasion", names: ["Autocasión"], domains: ["autocasion.com"], kind: "platform" },
  { slug: "seminuevos", names: ["Seminuevos.com"], domains: ["seminuevos.com"], kind: "platform" },
  { slug: "chileautos", names: ["Chileautos"], domains: ["chileautos.cl"], kind: "platform" },
  { slug: "neoauto", names: ["Neoauto"], domains: ["neoauto.com"], kind: "platform" },
  { slug: "patiotuerca", names: ["Patiotuerca"], domains: ["patiotuerca.com"], kind: "platform" },
  {
    slug: "autotrader",
    names: ["Autotrader", "AutoTrader"],
    domains: ["autotrader.com", "autotrader.co.uk"],
    kind: "platform",
  },
  { slug: "cars-com", names: ["Cars.com"], domains: ["cars.com"], kind: "platform" },
  { slug: "cargurus", names: ["CarGurus"], domains: ["cargurus.com"], kind: "platform" },
  {
    slug: "repairpal",
    names: ["RepairPal"],
    domains: ["repairpal.com"],
    kind: "directory_or_media",
  },
  {
    slug: "dealerrater",
    names: ["DealerRater"],
    domains: ["dealerrater.com"],
    kind: "directory_or_media",
  },

  {
    slug: "yelp",
    names: ["Yelp"],
    domains: [
      "yelp.com",
      "yelp.es",
      "yelp.com.mx",
      "yelp.com.ar",
      "yelp.cl",
      "yelp.com.br",
      "yelp.pt",
      "yelp.co.uk",
      "yelp.ca",
      "yelp.fr",
      "yelp.de",
      "yelp.it",
    ],
    kind: "platform",
  },
  {
    slug: "apple-maps",
    names: ["Apple Maps", "Apple Mapas"],
    domains: ["maps.apple.com", "maps.apple"],
    kind: "platform",
  },
  {
    slug: "foursquare",
    names: ["Foursquare"],
    domains: ["foursquare.com", "4sq.com"],
    kind: "directory_or_media",
  },
  { slug: "mapquest", names: ["MapQuest"], domains: ["mapquest.com"], kind: "directory_or_media" },
  { slug: "nextdoor", names: ["Nextdoor"], domains: ["nextdoor.com"], kind: "directory_or_media" },
  {
    slug: "bbb",
    names: ["BBB", "Better Business Bureau"],
    domains: ["bbb.org"],
    kind: "directory_or_media",
  },
  {
    slug: "trustpilot",
    names: ["Trustpilot"],
    domains: ["trustpilot.com"],
    kind: "directory_or_media",
  },
  { slug: "birdeye", names: ["Birdeye"], domains: ["birdeye.com"], kind: "directory_or_media" },
  {
    slug: "expertise-com",
    names: ["Expertise.com"],
    domains: ["expertise.com"],
    kind: "directory_or_media",
  },
  {
    slug: "three-best-rated",
    names: ["Three Best Rated", "ThreeBestRated"],
    domains: [
      "threebestrated.com",
      "threebestrated.ca",
      "threebestrated.co.uk",
      "threebestrated.com.au",
      "threebestrated.de",
      "threebestrated.fr",
    ],
    kind: "directory_or_media",
  },
  {
    slug: "trustlocal",
    names: ["Trustlocal"],
    domains: ["trustlocal.es", "trustlocal.de", "trustlocal.be"],
    kind: "directory_or_media",
  },
  { slug: "destaco", names: ["Destaco.es"], domains: ["destaco.es"], kind: "directory_or_media" },
  {
    slug: "paginas-amarillas",
    names: ["Páginas Amarillas", "PaginasAmarillas"],
    domains: [
      "paginasamarillas.es",
      "paginasamarillas.com.co",
      "paginasamarillas.com.ar",
      "paginasamarillas.com.pe",
    ],
    kind: "directory_or_media",
  },
  {
    slug: "seccion-amarilla",
    names: ["Sección Amarilla"],
    domains: ["seccionamarilla.com.mx"],
    kind: "directory_or_media",
  },
  {
    slug: "yellow-pages",
    names: ["Yellow Pages", "YellowPages", "YP.com"],
    domains: ["yellowpages.com"],
    kind: "directory_or_media",
  },
  { slug: "yell", names: ["Yell.com"], domains: ["yell.com"], kind: "directory_or_media" },
  {
    slug: "pagesjaunes",
    names: ["PagesJaunes", "Pages Jaunes"],
    domains: ["pagesjaunes.fr"],
    kind: "directory_or_media",
  },
  {
    slug: "gelbe-seiten",
    names: ["Gelbe Seiten", "GelbeSeiten"],
    domains: ["gelbeseiten.de"],
    kind: "directory_or_media",
  },
  {
    slug: "cylex",
    names: ["Cylex"],
    domains: [
      "cylex.es",
      "cylex.mx",
      "cylex.com.co",
      "cylex.com.ar",
      "cylex.cl",
      "cylex.com.pe",
      "cylex.de",
      "cylex-italia.it",
      "cylex-locale.fr",
      "cylex-canada.ca",
    ],
    kind: "directory_or_media",
  },

  {
    slug: "whatsapp",
    names: ["WhatsApp", "WhatsApp Business"],
    domains: ["whatsapp.com", "wa.me"],
    kind: "directory_or_media",
  },
  { slug: "linkedin", names: ["LinkedIn"], domains: ["linkedin.com"], kind: "directory_or_media" },
  // A bare "X" would match any one-letter name.
  {
    slug: "x",
    names: ["Twitter", "X (Twitter)", "X.com"],
    domains: ["x.com", "twitter.com"],
    kind: "directory_or_media",
  },
  {
    slug: "pinterest",
    names: ["Pinterest"],
    domains: ["pinterest.com"],
    kind: "directory_or_media",
  },
  { slug: "reddit", names: ["Reddit"], domains: ["reddit.com"], kind: "directory_or_media" },
  {
    slug: "wikipedia",
    names: ["Wikipedia"],
    domains: ["wikipedia.org"],
    kind: "directory_or_media",
  },
];

interface DomainRule {
  host: string;
  path: string;
  entry: PlatformEntry;
}

interface RegistryIndex {
  byName: Map<string, PlatformEntry>;
  domainRules: readonly DomainRule[];
}

// Built once per registry: the module's own and each extractor config's, which is hashed with it.
const INDEXES = new WeakMap<readonly PlatformEntry[], RegistryIndex>();

function indexOf(registry: readonly PlatformEntry[]): RegistryIndex {
  let index = INDEXES.get(registry);
  if (index) return index;
  index = {
    // Domains count as names too: answers often write "rappi.com" for Rappi.
    byName: new Map(
      registry.flatMap((entry) =>
        [...entry.names, ...entry.domains].map(
          (alias) => [normalizeName(alias, entry.kind), entry] as const,
        ),
      ),
    ),
    domainRules: registry.flatMap((entry) =>
      entry.domains.map((domain) => {
        const slash = domain.indexOf("/");
        return slash === -1
          ? { host: domain, path: "", entry }
          : { host: domain.slice(0, slash), path: domain.slice(slash), entry };
      }),
    ),
  };
  INDEXES.set(registry, index);
  return index;
}

// Label-wise suffix, so "notbooking.com" is not "booking.com".
function onHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function platformOfUrl(raw: string, rules: readonly DomainRule[]): PlatformEntry | null {
  const url = URL.parse(raw);
  if (!url) return null;
  const host = url.hostname.replace(/\.$/, "");
  for (const rule of rules) {
    if (!onHost(host, rule.host)) continue;
    if (rule.path && url.pathname !== rule.path && !url.pathname.startsWith(`${rule.path}/`)) {
      continue;
    }
    return rule.entry;
  }
  return null;
}

/** Exact alias match only: a business named "Hotel Booking Plaza" is still a business. */
export function platformFor(
  m: Pick<ExtractedMention, "nameNorm" | "citedUrls">,
  registry: readonly PlatformEntry[] = PLATFORMS,
): PlatformEntry | null {
  const index = indexOf(registry);
  const byName = index.byName.get(m.nameNorm);
  if (byName) return byName;
  for (const url of m.citedUrls) {
    const entry = platformOfUrl(url, index.domainRules);
    if (entry) return entry;
  }
  return null;
}

const CONCRETE_KINDS = new Set<EntityKind>(["business", "professional", "chain"]);

/** The registry overrides the model's entity kind; ranks are recounted since platforms hold none. */
export function tagPlatforms(
  mentions: ExtractedMention[],
  registry: readonly PlatformEntry[] = PLATFORMS,
): ExtractedMention[] {
  const { byName } = indexOf(registry);
  const tagged = mentions.map((mention) => {
    // A hotel cited through its Booking listing is still the hotel: only its name turns a
    // concrete entity into a platform.
    const entry = CONCRETE_KINDS.has(mention.entityKind)
      ? (byName.get(mention.nameNorm) ?? null)
      : platformFor(mention, registry);
    if (!entry || entry.kind === mention.entityKind) return { ...mention };
    return {
      ...mention,
      entityKind: entry.kind,
      nameNorm: normalizeName(mention.name, entry.kind),
    };
  });
  return assignOrdinals(tagged);
}
