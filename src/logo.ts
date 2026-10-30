// The ArcRoom shared-wall logo as MCP icons (spec: icons on serverInfo and tools; PNG must be supported, SVG should).
// `theme` = the background the icon is meant for: dark stroke on light backgrounds, light stroke on dark ones.
// PNGs are 64x64, rendered from the same paths as the website logo.

const svg = (stroke: string) =>
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 10 104 104"><path d="M18 104 V58 A21 21 0 0 1 60 58 A21 21 0 0 1 102 58 V104" fill="none" stroke="${stroke}" stroke-width="14" stroke-linejoin="round"/><path d="M60 60 V104" fill="none" stroke="#FF5B2E" stroke-width="14"/></svg>`,
  ).toString('base64');

const PNG_LIGHT_BG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAADqElEQVR4Aexau1LbQBS9K89Qg2Q8KVKYLn0KykCTfEbgSzBfAk3o06Q1+YWkSoXTZQw2LtIx1uYeWZLXQt5dWbKlWKvZa+/jPs+eXTyDPGr54wBoOQHIMcAxoOUIuCPQcgK4S9AdAXcEWo5AqSMQBMcXED/o3aTi9658lsNu9+zw8E2/CnwDjgOf/hbiFAYg4GSOguOhH/SkJHED4SIvUhE0IBZPekOvEz5AN2CbomDAxg96DyxRHPgkosrjWAMQcBE+J4SCBYkzsnwE68IGYATswwQEdPwYXA5hzSAlzjCwiMO+o2YEAAljF1EEW1gnxLqvGnwwEEP4zC5iTomTXS4y7iOO6Mxv4DNrmB1rAcA5RsJAN2tYYtxnnw/wnfhAH3NVxoEv9pkLdhIX32sBiJLic8xKpXad7XObx75xsYGu6OcqlZ9cgK25jHMBAHW2mNSyLL4sQdflxHZ6OibkAoDzs51UavMKJuQeh1cAgJY4PxumOtrQbhdmfc8LP2cDrQAA6sd/b7N6uWNJ8l6QvAzn3sl0MhYsJ6EIzzHHBrcsVbVb+FTiCMQhSQPkYB2Ej1xUo2KwAgCflStlTdtFQs+Tx/PJ5PF2NvuT7vzs6ekecwzGJXTYSbrG/cINhcIXfGbjTKfja+QAINixVZwsC1IAYmTwS4t9adsIO4GEtFq8CB3WPeeuVXKsp7YRFy4AqDqZ1wcQ1nEEDeJaI1cpAFlkotWcD96RS3UnclRWpqBrnZxiGdsoM/ou4jDjrvVai9VOZ57+kk0BWCwZPvnM2exI1guSY5ra3wmIoxyrrL91YzCO4wzWrSfzksSHpL8EQJCR/qAabfjEtjZHYRTrbhTJ0jaXAaZffDbJm5K+NylIklXEMflIa40YoF4KmgSNyWtsrZeEFFXEMfpIao4AsMpOkglVMj18SX036YReaNQx+eB7wDpXewCMUc0Kd+/9v6dHB6ST509vX8yeqtPYKQAfuwcv30590gnJebe68ohMvnYKgCmZOtYdAHWg3qSYjgFN2o06cnEMqAP1JsV0DGjSbtSRi2NAHag3KaZjQJN2o45cHAPqQL1JMfeOAUXBdQAURWzf9B0D9m1Hi9bjGFAUsX3TdwzYtx0tWo9jgIIY/p+2VoSQvxXdMt1fbKwTXq6kra2FvY+idxa4EzEAg+lkjBed1kr08gEblGni7udX8eXHO62wTpkYsMU7AqZ6oAeJAECnreIAaOvOJ3U7BiRI/K/fZfP+BwAA//+UjP8CAAAABklEQVQDAAelm5CWvAzJAAAAAElFTkSuQmCC';
const PNG_DARK_BG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAADqUlEQVR4AexbTXLaMBR+gk2YIXSc9ADJrrdoOEnDroseoLuQfZfdk0277wlINz1Am00XndADJEzBMyxSUL8nWx4wxpLAxC6WRs+2pPf76ZPDTKBBNW8egJoTgDwDPANqjoA/AjUngH8J+iPgj0DNEdjpCIST8WUkD4NwEsn0z8OVkun4YjYenxWBL8dgnzoG33msZMc4zgBwMuHkcQiRRHIQibgkikQI0Vci5XDelPfQg+740hWMUIH7yPYqDvvUMfjOYyU7xrEGQCcUFUwXZN+gKwcRGGYg4jiqaIRwYZCO4wS4EQDeuRA7HhfukhDyT3cFxJB9pld4bilOetlljBxVnAH7TBumx7kATHG+sHNDGAFdXIvpZ/B5z761O37mOYyLjHMBn5lgI07SNwLASQmcL2gCUVwL7uybX2Ihzjo/F+xeu1Ng5zEhEwA22GNSOjnil1h8tJK5fTzkMSETABjg7b6PVErzyUzIPA5rADAtkea2Z3EE26r2s7+NxZt0cisAKOrj73haKWd8SyR6zbk4b3dOBORcCtHlOVD7hgprEr5W4giOI6XsIwRywNWiC9Q2G69+OFsBYN5cXFn4iVVEDwV3253gphUEyc4fHwe3PNfunPYI4BBRskZbNC6UfbHPdJzjF6fX7c5JV0ZAWMVJsyABYKaQEfhEZ8xyFO14gF3J1+WkoQtGkFVytNpGKE4woKvT6yMGwjaOSLEgASCNzHqYaAY70mst7Xg0u/nKurbJLXuJbZancp85DpG4Jos2b1LyjksAIIsmQTWbHUm7agEw2BoZo+2g22cbPba9M+PY1qy/eK11EgCEMNOfqaYNXe+xrc1RGMW6riGUvp2tyGSA6ROfTfIqic0XafPGLiAOmXwktSoGzNQLkAzNKnmDD/OylEXEMfuYxTUrAMxpEUlJJlTJ3BpfjToNCx2DE5dcrQEwxLRaPvr4Pmz+uqM8ab/tPlk5K0jpWQFo3n17OvrwjvKE5PxlQbUpN6bLswJgSqaMdQ9AGahXKaZnQJV2o4xcPAPKQL1KMT0DqrQbZeTiGVAG6lWK6RlQpd0oIxfPgDJQr1LMg2OAK7geAFfEDk3fM+DQdtS1Hs8AV8QOTd8z4NB21LUez4AlxPh/fxtFiMbvJd1dHn/COE+wXEjfWAu8j1pBwOvRL0Z40O6c8BedciSw/oIDAmR28fnHF/Hp+6tcgU6mscMkf0fAVI9254+ARqKud8+Auu68rvu/Z4AuZNv7PwAAAP//+WPCTQAAAAZJREFUAwCt5dOQ/FC9ZQAAAABJRU5ErkJggg==';

export const ICONS = [
  { src: PNG_LIGHT_BG, mimeType: 'image/png', sizes: ['64x64'], theme: 'light' },
  { src: PNG_DARK_BG, mimeType: 'image/png', sizes: ['64x64'], theme: 'dark' },
  { src: svg('#121316'), mimeType: 'image/svg+xml', sizes: ['any'], theme: 'light' },
  { src: svg('#F4F2EE'), mimeType: 'image/svg+xml', sizes: ['any'], theme: 'dark' },
];
