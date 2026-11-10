/* config.js: instellingen en teksten. Pas hier aan, niet in app.js. */
window.ISO_CONFIG = {
  titel: 'Isochronenkaart Rotterdam',
  ondertitel: 'Hoe ver kom je lopend of fietsend?',

  modi: {
    lopen: { label: 'Lopen', snelheid: 5, min: 3, max: 7, stap: 0.5 },
    fietsen: { label: 'Fietsen', snelheid: 15, min: 10, max: 25, stap: 1 },
  },
  standaardBanden: [5, 10, 15],
  maxBanden: 5,
  maxMinuten: 45,
  maxLocaties: 25,
  maxPerLocatie: 8, // daarboven alleen 'Gecombineerd' (8 onderscheidbare kleuren)

  // Tijdbanden: één blauwe tint, donker = dichtbij (gevalideerd op grijze ondergrond)
  bandKleuren: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec'],
  // Locaties: vaste volgorde, nooit herhalen (zie maxPerLocatie)
  locatieKleuren: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  accent: '#00811F',

  basiskaarten: {
    grijs: 'Grijs',
    standaard: 'Kleur',
  },
  basiskaartUrl: 'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/{thema}/EPSG:3857/{z}/{x}/{y}.png',

  locatieserver: 'https://api.pdok.nl/bzk/locatieserver/search/v3_1',
  gemeente: 'Rotterdam',

  disclaimer:
    'Deze kaart is gemaakt met behulp van AI en is indicatief. Reistijden zijn berekend met vaste ' +
    'snelheden op het OpenStreetMap-netwerk, zonder wachttijden bij kruispunten, brugopeningen of ' +
    'veerverbindingen. Aan de weergave kunnen geen rechten worden ontleend.',
  // Vul in om een contactregel te tonen, bijvoorbeeld { naam: 'Team X', email: 'x@rotterdam.nl' }
  contact: { naam: '', email: '' },
};
