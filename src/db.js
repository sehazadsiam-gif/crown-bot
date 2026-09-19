import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FILE = resolve(process.cwd(), 'data/crown.db');
mkdirSync(dirname(FILE), { recursive: true });

export const db = new Database(FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  json     TEXT NOT NULL,
  updated  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform     TEXT NOT NULL,               -- 'facebook' | 'instagram'
  psid         TEXT NOT NULL,               -- page-scoped user id
  name         TEXT,
  bot_enabled  INTEGER NOT NULL DEFAULT 1,
  flagged      INTEGER NOT NULL DEFAULT 0,
  flag_reason  TEXT,
  last_msg_at  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(platform, psid)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL,                -- 'in' | 'out'
  text        TEXT NOT NULL,
  model       TEXT,
  mid         TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_mid ON messages(mid) WHERE mid IS NOT NULL;

CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                -- 'order' | 'reservation'
  details     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seen (
  mid   TEXT PRIMARY KEY,
  at    INTEGER NOT NULL
);
`);

const now = () => new Date().toISOString();

/* ───────── config ───────── */
export const DEFAULT_CONFIG = {
  cafe: {
    name: 'Crown Coffee',
    phone: '01806-576024',
    area: 'Sector 13, Uttara, Dhaka',
    address: '6 Shah Makhdum Avenue, Assure Ayan Tower, Sector 13, Uttara, Dhaka',
    open: '11:00', close: '23:00', offDay: '', holidayNote: 'Open every day including Fridays and public holidays. Last order at 22:30.',
    wifi: 'Yes, free high-speed guest Wi-Fi and power outlets available for work/study',
    parking: 'Roadside and building parking available for cars and bikes',
    seating: 'Comfortable seating for dine-in, work/study, and birthday/private events',
    payments: 'Cash, Cards (Visa, Mastercard, Amex), bKash, Nagad',
    service: 'Dine-in, takeaway, and event reservations',
    apps: 'Foodpanda, Pathao Food',
    notes: 'Separate designated smoking zone available. All food and meats are 100% Halal. All menu prices are inclusive of VAT.'
  },
  menu: [
    {
      "id": "1yx9u0",
      "name": "Breakfast",
      "items": [
        {
          "id": "5x75b8",
          "name": "Traditional Breakfast",
          "desc": "Paratha, eggs, chicken and lemon butter.",
          "price": 390,
          "available": true
        },
        {
          "id": "j2vdrr",
          "name": "American Breakfast",
          "desc": "Eggs, sausages, baked beans, mushrooms, toast and peanut butter.",
          "price": 370,
          "available": true
        },
        {
          "id": "jky6vi",
          "name": "Brunch Delight",
          "desc": "Bread, eggs, baked beans, sausages, chicken, butter and jelly.",
          "price": 430,
          "available": true
        }
      ]
    },
    {
      "id": "8ixq4p",
      "name": "Sandwich",
      "items": [
        {
          "id": "27i4tc",
          "name": "Chicken Sandwich",
          "desc": "Smoky tender chicken in a fresh sandwich.",
          "price": 385,
          "available": true
        },
        {
          "id": "d9dgyn",
          "name": "Mushroom Sandwich",
          "desc": "Chicken and mushrooms, perfectly seasoned and generously filled.",
          "price": 490,
          "available": true
        },
        {
          "id": "h7dhsi",
          "name": "Classic Club Sandwich",
          "desc": "Classic club sandwich with a satisfying crunch.",
          "price": 580,
          "available": true
        }
      ]
    },
    {
      "id": "ckgc1r",
      "name": "Appetizers",
      "items": [
        {
          "id": "xtmdlj",
          "name": "French Fries",
          "desc": "Simple and classic.",
          "price": 210,
          "available": true
        },
        {
          "id": "xb870w",
          "name": "Japanese Fried Chicken",
          "desc": "Crispy bite-sized chicken, juicy inside and golden outside.",
          "price": 365,
          "available": true
        },
        {
          "id": "uo3gfy",
          "name": "Chicken Nanban",
          "desc": "Crispy chicken with creamy sweet-spicy sauce.",
          "price": 345,
          "available": true
        },
        {
          "id": "xzmjyr",
          "name": "Chicken Gyoza",
          "desc": "Crispy golden chicken gyoza.",
          "price": 340,
          "available": true
        },
        {
          "id": "1ky4gu",
          "name": "Steamed Wonton",
          "desc": "Steamed wontons with a light savory filling.",
          "price": 290,
          "available": true
        },
        {
          "id": "hny8aj",
          "name": "Fried Sesame Dory",
          "desc": "Crispy fried dory with aromatic sesame.",
          "price": 520,
          "available": true
        },
        {
          "id": "b8tpe0",
          "name": "Fish & Chips",
          "desc": "Crispy fried dory with toasted sesame and tangy sauce.",
          "price": 570,
          "available": true
        },
        {
          "id": "31ms31",
          "name": "High Tea (1:4)",
          "desc": "Wonton, chicken wings, chicken satay, fish fingers and fries.",
          "price": 745,
          "available": true
        }
      ]
    },
    {
      "id": "4wdev4",
      "name": "Soup",
      "items": [
        {
          "id": "i35tsj",
          "name": "Thai Clear Soup",
          "desc": "Chicken, fresh herbs and a hint of citrus.",
          "price": 260,
          "available": true
        },
        {
          "id": "l39ln4",
          "name": "Thai Thick Soup",
          "desc": "Prawns, chicken, ginger, lime and chilli paste.",
          "price": 310,
          "available": true
        },
        {
          "id": "fq88d9",
          "name": "Cream of Mushroom Soup",
          "desc": "Roasted mushroom, garlic, onion, celery, cream and parsley.",
          "price": 380,
          "available": true
        }
      ]
    },
    {
      "id": "zj7qdb",
      "name": "Pasta",
      "items": [
        {
          "id": "e0jrmt",
          "name": "Creamy Fettuccine Alfredo",
          "desc": "Tender meats in a creamy Alfredo sauce.",
          "price": 490,
          "available": true
        },
        {
          "id": "dng91x",
          "name": "Beef Bolognese Pasta",
          "desc": "Beef Bolognese in rich tomato sauce.",
          "price": 580,
          "available": true
        },
        {
          "id": "l3gsg6",
          "name": "Pasta De La Casa",
          "desc": "Prawns and chicken with Alfredo, chilli and herbs.",
          "price": 895,
          "available": true
        }
      ]
    },
    {
      "id": "yw8dat",
      "name": "Noodles",
      "items": [
        {
          "id": "rkpuq2",
          "name": "Stir Fried Chicken Noodles",
          "desc": "Chicken, onion, sauce and herbs.",
          "price": 380,
          "available": true
        },
        {
          "id": "jzy6xy",
          "name": "Stir Fried Beef Noodles",
          "desc": "Spicy beef noodles with herbs and spices.",
          "price": 460,
          "available": true
        }
      ]
    },
    {
      "id": "600vsz",
      "name": "Salad",
      "items": [
        {
          "id": "z0do2l",
          "name": "Cashew Nut Salad",
          "desc": "Chicken, vegetables and roasted cashews with light tangy dressing.",
          "price": 465,
          "available": true
        },
        {
          "id": "yaj7uu",
          "name": "Spanish Grilled Chicken Salad",
          "desc": "Grilled chicken, seasonal vegetables and balsamic dressing.",
          "price": 380,
          "available": true
        }
      ]
    },
    {
      "id": "jz33s4",
      "name": "Pizza",
      "items": [
        {
          "id": "9p6soj",
          "name": "BBQ Chicken Pizza (9\")",
          "desc": "Grilled chicken, cheddar, mozzarella and BBQ sauce.",
          "price": 595,
          "available": true
        },
        {
          "id": "1jt7xf",
          "name": "BBQ Chicken Pizza (12\")",
          "desc": "Grilled chicken, cheddar, mozzarella and BBQ sauce.",
          "price": 980,
          "available": true
        },
        {
          "id": "gr6tqr",
          "name": "Beef Bolognese Pizza (9\")",
          "desc": "Beef, cheese and aromatic seasoning.",
          "price": 845,
          "available": true
        },
        {
          "id": "hbnhm6",
          "name": "Beef Bolognese Pizza (12\")",
          "desc": "Beef, cheese and aromatic seasoning.",
          "price": 1330,
          "available": true
        },
        {
          "id": "22kkek",
          "name": "CC Special Four Seasons",
          "desc": "Beef, chicken, squid, dory and overloaded cheese.",
          "price": 1495,
          "available": true
        }
      ]
    },
    {
      "id": "js6xgo",
      "name": "Main Course",
      "items": [
        {
          "id": "q90vqb",
          "name": "Chicken Schnitzel",
          "desc": "Breaded chicken breast served with rice.",
          "price": 580,
          "available": true
        },
        {
          "id": "6ilbmp",
          "name": "Turkish Savory",
          "desc": "Fluffy rice with spiced chicken and sautéed vegetables.",
          "price": 395,
          "available": true
        },
        {
          "id": "lmh5j4",
          "name": "Basil Leaf Beef (Spicy)",
          "desc": "Spicy basil beef served with rice.",
          "price": 460,
          "available": true
        },
        {
          "id": "39ywrj",
          "name": "Herbed Dory with Salsa",
          "desc": "Grilled dory with spicy salsa and rice.",
          "price": 440,
          "available": true
        },
        {
          "id": "uxbhfp",
          "name": "King Prawn",
          "desc": "King prawns with rice and sautéed vegetables.",
          "price": 690,
          "available": true
        },
        {
          "id": "3xei9e",
          "name": "Peri Peri Chicken",
          "desc": "Peri peri chicken with fragrant rice and vegetables.",
          "price": 410,
          "available": true
        },
        {
          "id": "58oyzx",
          "name": "Crown Coffee Special Rice",
          "desc": "Chicken, beef, prawn and calamari mixed rice.",
          "price": 760,
          "available": true
        }
      ]
    },
    {
      "id": "36yp27",
      "name": "Dessert",
      "items": [
        {
          "id": "pysa3v",
          "name": "Chawanmushi",
          "desc": "Silky Japanese steamed egg custard.",
          "price": 195,
          "available": true
        },
        {
          "id": "kow2ft",
          "name": "Crêpe",
          "desc": "Soft and thin crepe with delicious toppings.",
          "price": 260,
          "available": true
        },
        {
          "id": "q4txcq",
          "name": "Sweet Madness",
          "desc": "Two scoops of ice cream, Swiss cake and fresh fruits.",
          "price": 340,
          "available": true
        },
        {
          "id": "jg2ems",
          "name": "Chocolate Lava",
          "desc": "Chocolate lava dessert with ice cream.",
          "price": 220,
          "available": true
        }
      ]
    },
    {
      "id": "8ede41",
      "name": "Coffee",
      "items": [
        {
          "id": "117dfa",
          "name": "Espresso",
          "desc": "",
          "price": 190,
          "available": true
        },
        {
          "id": "wfs327",
          "name": "Macchiato",
          "desc": "",
          "price": 195,
          "available": true
        },
        {
          "id": "525rmb",
          "name": "Americano",
          "desc": "",
          "price": 199,
          "available": true
        },
        {
          "id": "51tlr6",
          "name": "Cappuccino",
          "desc": "",
          "price": 280,
          "available": true
        },
        {
          "id": "3tmh6v",
          "name": "Cappuccino Small",
          "desc": "",
          "price": 180,
          "available": true
        },
        {
          "id": "8sevij",
          "name": "Latte",
          "desc": "",
          "price": 310,
          "available": true
        },
        {
          "id": "co35z5",
          "name": "Affogato",
          "desc": "",
          "price": 229,
          "available": true
        },
        {
          "id": "n6eofe",
          "name": "Flat White",
          "desc": "",
          "price": 240,
          "available": true
        }
      ]
    },
    {
      "id": "amm3ra",
      "name": "Boba Special",
      "items": [
        {
          "id": "20fagb",
          "name": "Iced Coffee Boba Milk Tea",
          "desc": "",
          "price": 289,
          "available": true
        }
      ]
    },
    {
      "id": "zhb1sa",
      "name": "Shakes",
      "items": [
        {
          "id": "45iyb5",
          "name": "Nutella",
          "desc": "",
          "price": 399,
          "available": true
        }
      ]
    },
    {
      "id": "c86s0f",
      "name": "Iced Coffee",
      "items": [
        {
          "id": "rv6zkb",
          "name": "Iced Americano",
          "desc": "",
          "price": 230,
          "available": true
        },
        {
          "id": "8q8k3y",
          "name": "Iced Cappuccino",
          "desc": "",
          "price": 290,
          "available": true
        },
        {
          "id": "z4ror0",
          "name": "Iced Latte",
          "desc": "",
          "price": 330,
          "available": true
        }
      ]
    },
    {
      "id": "no0im6",
      "name": "Smoothie",
      "items": [
        {
          "id": "p6rs58",
          "name": "Mango",
          "desc": "",
          "price": 399,
          "available": true
        },
        {
          "id": "7s6cu8",
          "name": "Strawberry",
          "desc": "",
          "price": 399,
          "available": true
        },
        {
          "id": "1p2brl",
          "name": "Peach",
          "desc": "",
          "price": 419,
          "available": true
        }
      ]
    },
    {
      "id": "iiarg1",
      "name": "Hot Chocolate",
      "items": [
        {
          "id": "5huyn1",
          "name": "Regular Hot Chocolate",
          "desc": "",
          "price": 289,
          "available": true
        },
        {
          "id": "n7c2qs",
          "name": "Frozen Hot Chocolate",
          "desc": "",
          "price": 299,
          "available": true
        }
      ]
    },
    {
      "id": "rol8qb",
      "name": "Mocktails",
      "items": [
        {
          "id": "189t0t",
          "name": "Mint Lemonade",
          "desc": "",
          "price": 239,
          "available": true
        },
        {
          "id": "7keqwo",
          "name": "Blu Ocean",
          "desc": "",
          "price": 299,
          "available": true
        },
        {
          "id": "z9gbcn",
          "name": "Vanilla",
          "desc": "",
          "price": 299,
          "available": true
        },
        {
          "id": "mvb0j9",
          "name": "Chocolate",
          "desc": "",
          "price": 299,
          "available": true
        },
        {
          "id": "pmp1x0",
          "name": "Oreo",
          "desc": "",
          "price": 299,
          "available": true
        },
        {
          "id": "tm8yx6",
          "name": "Mango",
          "desc": "",
          "price": 299,
          "available": true
        },
        {
          "id": "3fjx9o",
          "name": "Blueberry",
          "desc": "",
          "price": 299,
          "available": true
        },
        {
          "id": "71pf0l",
          "name": "Strawberry",
          "desc": "",
          "price": 299,
          "available": true
        },
        {
          "id": "8d0mma",
          "name": "Hurricane",
          "desc": "",
          "price": 399,
          "available": true
        },
        {
          "id": "gil0m7",
          "name": "Crown Coffee Special",
          "desc": "",
          "price": 410,
          "available": true
        }
      ]
    },
    {
      "id": "zochif",
      "name": "Frappe",
      "items": [
        {
          "id": "fsjf3k",
          "name": "Hazelnut",
          "desc": "",
          "price": 409,
          "available": true
        },
        {
          "id": "d4hobm",
          "name": "Caramel",
          "desc": "",
          "price": 409,
          "available": true
        },
        {
          "id": "h6619e",
          "name": "Salted Caramel",
          "desc": "",
          "price": 409,
          "available": true
        },
        {
          "id": "660tjo",
          "name": "Vanilla",
          "desc": "",
          "price": 399,
          "available": true
        },
        {
          "id": "r2ids7",
          "name": "Mocha",
          "desc": "",
          "price": 399,
          "available": true
        },
        {
          "id": "ni0x4a",
          "name": "Tiramisu",
          "desc": "",
          "price": 415,
          "available": true
        }
      ]
    },
    {
      "id": "52xmf7",
      "name": "Fresh Juices",
      "items": [
        {
          "id": "fjyyxm",
          "name": "Orange Juice",
          "desc": "",
          "price": 289,
          "available": true
        },
        {
          "id": "nuillc",
          "name": "Pineapple Juice",
          "desc": "",
          "price": 209,
          "available": true
        },
        {
          "id": "o01la7",
          "name": "Papaya Juice",
          "desc": "",
          "price": 159,
          "available": true
        },
        {
          "id": "idg8d2",
          "name": "Apple Juice",
          "desc": "",
          "price": 489,
          "available": true
        }
      ]
    },
    {
      "id": "cuxerz",
      "name": "Ice Cream",
      "items": [
        {
          "id": "yf5s36",
          "name": "Vanilla",
          "desc": "",
          "price": 155,
          "available": true
        },
        {
          "id": "1lwn53",
          "name": "Chocolate",
          "desc": "",
          "price": 155,
          "available": true
        },
        {
          "id": "sijqz6",
          "name": "Mango",
          "desc": "",
          "price": 155,
          "available": true
        }
      ]
    },
    {
      "id": "nqx817",
      "name": "Add-on Flavours",
      "items": [
        {
          "id": "j4yabh",
          "name": "Hazelnut",
          "desc": "",
          "price": 99,
          "available": true
        },
        {
          "id": "vog5jy",
          "name": "Caramel",
          "desc": "",
          "price": 99,
          "available": true
        },
        {
          "id": "usrrv1",
          "name": "Vanilla",
          "desc": "",
          "price": 99,
          "available": true
        },
        {
          "id": "prg0s7",
          "name": "Mocha",
          "desc": "",
          "price": 99,
          "available": true
        },
        {
          "id": "ds1v3q",
          "name": "Salted Caramel",
          "desc": "",
          "price": 99,
          "available": true
        },
        {
          "id": "uqmp7b",
          "name": "Tiramisu",
          "desc": "",
          "price": 99,
          "available": true
        }
      ]
    },
    {
      "id": "0mery9",
      "name": "Traditionals",
      "items": [
        {
          "id": "ojib2e",
          "name": "Mango Lassi",
          "desc": "",
          "price": 319,
          "available": true
        },
        {
          "id": "fpoxid",
          "name": "Strawberry Lassi",
          "desc": "",
          "price": 339,
          "available": true
        }
      ]
    }
  ],
  faqs: [
    {
      id: 'f1',
      q: 'Where exactly in Sector 13 are you located? Any nearby landmark?',
      a: 'We are located at 6 Shah Makhdum Avenue, Assure Ayan Tower, Sector 13, Uttara, Dhaka.'
    },
    {
      id: 'f2',
      q: 'Is there parking available for cars and bikes?',
      a: 'Yes, roadside and building parking is available for cars and bikes.'
    },
    {
      id: 'f3',
      q: 'Are you open on Fridays and government/Eid holidays?',
      a: 'Yes, we are open every day from 11:00 AM to 11:00 PM, including Fridays and public holidays.'
    },
    {
      id: 'f4',
      q: 'What is the last order time?',
      a: 'Our kitchen takes last orders at 10:30 PM (22:30).'
    },
    {
      id: 'f5',
      q: 'Is the cafe suitable for work/study with laptops and charging ports?',
      a: 'Yes! We have high-speed Wi-Fi, comfortable seating, and power outlets near tables.'
    },
    {
      id: 'f6',
      q: 'Do you have a dedicated smoking zone or outdoor seating?',
      a: 'Yes, we have a separate designated smoking zone.'
    },
    {
      id: 'f7',
      q: 'Can we arrange birthday celebrations or private events?',
      a: 'Yes, you can celebrate birthdays and private events! For custom decoration or group bookings, please message us or call 01806-576024.'
    },
    {
      id: 'f8',
      q: 'Is all food 100% Halal?',
      a: 'Yes, all our food items and meat are 100% Halal certified.'
    },
    {
      id: 'f9',
      q: 'What payment methods do you accept?',
      a: 'We accept Cash, Cards (Visa, Mastercard, Amex), bKash, and Nagad.'
    },
    {
      id: 'f10',
      q: 'Do you offer home delivery or are you on Foodpanda/Pathao?',
      a: 'Yes, you can order directly for takeaway/parcel, and find us on Foodpanda and Pathao Food.'
    },
    {
      id: 'f11',
      q: 'Are menu prices inclusive of VAT/Service Charge?',
      a: 'Yes, all prices shown on our menu are inclusive of VAT.'
    }
  ],
  persona: {
    tone: 'Polite and professional, warm but not chatty',
    length: 'Short — 1 to 3 sentences',
    language: 'Reply in the exact same language and script the customer used. If they write Bangla, reply in Bangla. If they write Banglish (Bangla words in English letters), reply in Banglish the same way — do not convert it to Bangla script. If they write English, reply in English. Never mix scripts in one reply and never correct how the customer writes.',
    greeting: 'Assalamu Alaikum! Welcome to Crown Coffee.',
    emoji: false,
    disclose: false
  },
  channels: {
    facebook: {
      enabled: true,
      pageToken: process.env.FB_PAGE_TOKEN || '',
      pageId: process.env.FB_PAGE_ID || '',
      appSecret: process.env.META_APP_SECRET || '',
      verifyToken: process.env.META_VERIFY_TOKEN || 'botcrowncoffee'
    },
    instagram: {
      enabled: !!(process.env.IG_TOKEN || process.env.IG_USER_ID),
      token: process.env.IG_TOKEN || '',
      userId: process.env.IG_USER_ID || '',
      graphHost: process.env.IG_GRAPH_HOST || 'https://graph.facebook.com'
    },
    whatsapp: {
      enabled: !!(process.env.WA_TOKEN || process.env.WA_PHONE_NUMBER_ID),
      phoneNumberId: process.env.WA_PHONE_NUMBER_ID || '',
      wabaId: process.env.WA_BUSINESS_ACCOUNT_ID || '',
      token: process.env.WA_TOKEN || '',
      verifyToken: process.env.WA_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || 'botcrowncoffee'
    },
    tiktok: {
      enabled: !!(process.env.TIKTOK_ACCESS_TOKEN || process.env.TIKTOK_CLIENT_KEY),
      clientKey: process.env.TIKTOK_CLIENT_KEY || '',
      clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
      token: process.env.TIKTOK_ACCESS_TOKEN || ''
    }
  },
  scope: { answer: true, reserve: 'draft', order: 'draft', complaint: 'ack' },
  guards: [
    'Never state a price that is not in the menu below. If an item is not listed, say you will check and a team member will confirm.',
    'Never invent menu items, ingredients, or nutritional information.',
    'Never confirm an order or reservation as final — only say it has been requested.',
    'Never promise a delivery time or a discount.',
    'Never give medical or allergy advice. Pass allergy questions to a human.',
    'If you do not know something, say so plainly and offer to have a team member follow up.'
  ],
  esc: ['refund', 'complaint', 'manager', 'allergy', 'allergic', 'sick', 'lawyer', 'press',
        'ফেরত', 'অভিযোগ', 'ম্যানেজার'],
  runtime: { enabled: true, offHours: 'reply', fallbackText: 'Thanks for your message! Our team will reply shortly.' }
};

export function getConfig() {
  const row = db.prepare('SELECT json FROM config WHERE id = 1').get();
  if (!row) {
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const parsed = JSON.parse(row.json);
    let updated = false;
    const hasMenu = (parsed.menu || []).some(c => c.items?.length);
    if (!hasMenu && DEFAULT_CONFIG.menu?.length) {
      parsed.menu = structuredClone(DEFAULT_CONFIG.menu);
      updated = true;
    }
    if ((!parsed.faqs || !parsed.faqs.length) && DEFAULT_CONFIG.faqs?.length) {
      parsed.faqs = structuredClone(DEFAULT_CONFIG.faqs);
      updated = true;
    }
    if (DEFAULT_CONFIG.cafe) {
      for (const [k, v] of Object.entries(DEFAULT_CONFIG.cafe)) {
        if (!parsed.cafe?.[k] && v) {
          parsed.cafe = parsed.cafe || {};
          parsed.cafe[k] = v;
          updated = true;
        }
      }
    }
    parsed.channels = parsed.channels || {};
    for (const [ch, def] of Object.entries(DEFAULT_CONFIG.channels)) {
      parsed.channels[ch] = { ...def, ...(parsed.channels[ch] || {}) };
      // Fallback to env vars if fields are empty
      for (const [k, v] of Object.entries(def)) {
        if (!parsed.channels[ch][k] && v) parsed.channels[ch][k] = v;
      }
    }
    const merged = { ...structuredClone(DEFAULT_CONFIG), ...parsed };
    if (updated) saveConfig(merged);
    return merged;
  }
  catch { return structuredClone(DEFAULT_CONFIG); }
}

export function saveConfig(cfg) {
  db.prepare(`INSERT INTO config (id, json, updated) VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated = excluded.updated`)
    .run(JSON.stringify(cfg), now());
}

/* ───────── dedupe ───────── */
export function alreadySeen(mid) {
  if (!mid) return false;
  const hit = db.prepare('SELECT 1 FROM seen WHERE mid = ?').get(mid);
  if (hit) return true;
  db.prepare('INSERT INTO seen (mid, at) VALUES (?, ?)').run(mid, Date.now());
  db.prepare('DELETE FROM seen WHERE at < ?').run(Date.now() - 7 * 864e5);
  return false;
}

/* ───────── conversations ───────── */
export function upsertConversation(platform, psid, name) {
  db.prepare(`INSERT INTO conversations (platform, psid, name, last_msg_at, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(platform, psid) DO UPDATE SET
                last_msg_at = excluded.last_msg_at,
                name = COALESCE(excluded.name, conversations.name)`)
    .run(platform, psid, name || null, now(), now());
  return db.prepare('SELECT * FROM conversations WHERE platform = ? AND psid = ?').get(platform, psid);
}

export const listConversations = () => db.prepare(`
  SELECT c.*, (SELECT text FROM messages m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) AS preview
  FROM conversations c ORDER BY c.flagged DESC, c.last_msg_at DESC LIMIT 200`).all();

export const getConversation = id =>
  db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);

export const getMessages = (convId, limit = 60) =>
  db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?')
    .all(convId, limit).reverse();

export function addMessage(convId, direction, text, model = null, mid = null) {
  db.prepare('INSERT OR IGNORE INTO messages (conv_id, direction, text, model, mid, created_at) VALUES (?,?,?,?,?,?)')
    .run(convId, direction, text, model, mid, now());
  db.prepare('UPDATE conversations SET last_msg_at = ? WHERE id = ?').run(now(), convId);
}

export const setBotEnabled = (id, on) =>
  db.prepare('UPDATE conversations SET bot_enabled = ? WHERE id = ?').run(on ? 1 : 0, id);

export const setFlag = (id, on, reason = null) =>
  db.prepare('UPDATE conversations SET flagged = ?, flag_reason = ? WHERE id = ?').run(on ? 1 : 0, reason, id);

export const addDraft = (convId, kind, details) =>
  db.prepare('INSERT INTO drafts (conv_id, kind, details, created_at) VALUES (?,?,?,?)')
    .run(convId, kind, details, now());

export const listDrafts = () => db.prepare(`
  SELECT d.*, c.name, c.platform FROM drafts d JOIN conversations c ON c.id = d.conv_id
  WHERE d.status = 'pending' ORDER BY d.id DESC`).all();

export function stats() {
  const q = (s, ...args) => (db.prepare(s).get(...args) || {}).n || 0;
  const byPlatform = db.prepare('SELECT platform, COUNT(*) as count FROM conversations GROUP BY platform').all();
  const platformCounts = { facebook: 0, instagram: 0, whatsapp: 0, tiktok: 0 };
  for (const row of byPlatform) {
    if (row.platform in platformCounts) platformCounts[row.platform] = row.count;
  }

  const aiReplies = q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND (model IS NULL OR model != 'human')");
  const humanReplies = q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND model = 'human'");

  return {
    conversations: q('SELECT COUNT(*) n FROM conversations'),
    messagesIn:    q("SELECT COUNT(*) n FROM messages WHERE direction = 'in'"),
    messagesOut:   q("SELECT COUNT(*) n FROM messages WHERE direction = 'out'"),
    flagged:       q('SELECT COUNT(*) n FROM conversations WHERE flagged = 1'),
    today:         q("SELECT COUNT(*) n FROM messages WHERE date(created_at, '+6 hours') = date('now', '+6 hours')"),
    todayIn:       q("SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND date(created_at, '+6 hours') = date('now', '+6 hours')"),
    todayOut:      q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND date(created_at, '+6 hours') = date('now', '+6 hours')"),
    aiReplies,
    humanReplies,
    byPlatform: platformCounts
  };
}
