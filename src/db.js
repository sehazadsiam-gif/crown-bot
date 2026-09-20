import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

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

CREATE TABLE IF NOT EXISTS workspaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_configs (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  json         TEXT NOT NULL,
  updated      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id         INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email                TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  role                 TEXT NOT NULL DEFAULT 'tenant_admin',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  workspace_id         INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'trial',
  plan_name            TEXT NOT NULL DEFAULT '14-Day Free Trial',
  trial_ends_at        TEXT NOT NULL,
  active_until         TEXT,
  monthly_fee          INTEGER NOT NULL DEFAULT 500,
  contact_email        TEXT,
  contact_phone        TEXT,
  notes                TEXT,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,               -- 'facebook' | 'instagram' | 'whatsapp' | 'tiktok'
  account_id   TEXT NOT NULL,               -- page id, ig user id, wa phone id, tiktok key
  name         TEXT,
  token        TEXT,
  config_json  TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  UNIQUE(platform, account_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL DEFAULT 1 REFERENCES workspaces(id),
  platform     TEXT NOT NULL,               -- 'facebook' | 'instagram' | 'whatsapp' | 'tiktok'
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
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL DEFAULT 1 REFERENCES workspaces(id),
  conv_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                -- 'order' | 'reservation'
  details      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id     INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conv_id          INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  platform         TEXT DEFAULT 'web',
  customer_name    TEXT,
  customer_phone   TEXT,
  customer_address TEXT,
  details          TEXT NOT NULL,
  estimated_total  TEXT,
  status           TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'confirmed' | 'rejected'
  notes            TEXT,
  created_at       TEXT NOT NULL,
  confirmed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_ws ON orders(workspace_id, status);

CREATE TABLE IF NOT EXISTS seen (
  mid   TEXT PRIMARY KEY,
  at    INTEGER NOT NULL
);
`);

// Dynamic column migrations for existing databases
try {
  const convCols = db.pragma('table_info(conversations)');
  if (!convCols.some(c => c.name === 'workspace_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN workspace_id INTEGER DEFAULT 1');
  }
} catch (e) {
  console.error('Migration warning (conversations.workspace_id):', e.message);
}

try {
  const draftCols = db.pragma('table_info(drafts)');
  if (!draftCols.some(c => c.name === 'workspace_id')) {
    db.exec('ALTER TABLE drafts ADD COLUMN workspace_id INTEGER DEFAULT 1');
  }
} catch (e) {
  console.error('Migration warning (drafts.workspace_id):', e.message);
}

try {
  const userCols = db.pragma('table_info(workspace_users)');
  if (!userCols.some(c => c.name === 'password_display')) {
    db.exec('ALTER TABLE workspace_users ADD COLUMN password_display TEXT');
  }
} catch (e) {
  console.error('Migration warning (workspace_users.password_display):', e.message);
}

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

export function makeCleanTemplate(businessName = 'New Business', businessType = 'General Business', services = '') {
  return {
    business: {
      name: businessName,
      type: businessType || 'General Business',
      services: services || '',
      phone: '',
      area: '',
      address: '',
      open: '09:00',
      close: '21:00',
      offDay: '',
      holidayNote: 'Open during regular business hours.',
      wifi: 'Available',
      parking: 'Available',
      seating: 'Available',
      payments: 'Cash, Card, Mobile Banking (bKash/Nagad)',
      service: services || 'Customer service, inquiries, orders, bookings',
      apps: '',
      notes: ''
    },
    cafe: {
      name: businessName,
      type: businessType || 'General Business',
      services: services || '',
      phone: '',
      area: '',
      address: '',
      open: '09:00',
      close: '21:00',
      offDay: '',
      holidayNote: 'Open during regular business hours.',
      wifi: 'Available',
      parking: 'Available',
      seating: 'Available',
      payments: 'Cash, Card, Mobile Banking (bKash/Nagad)',
      service: services || 'Customer service, inquiries, orders, bookings',
      apps: '',
      notes: ''
    },
    persona: {
      tone: 'friendly, welcoming, professional, and clear',
      length: '1 to 3 short sentences, concise and directly answering the customer',
      emoji: false,
      language: 'Banglish or English or Bengali depending on customer inquiry',
      greeting: '',
      disclose: false
    },
    menu: [],
    faqs: [],
    channels: {
      facebook: { enabled: true, pageToken: '', pageId: '', appSecret: '', verifyToken: 'botcrowncoffee' },
      instagram: { enabled: true, token: '', userId: '', graphHost: 'https://graph.facebook.com' },
      whatsapp: { enabled: true, phoneNumberId: '', wabaId: '', token: '', verifyToken: 'botcrowncoffee' },
      tiktok: { enabled: true, clientKey: '', clientSecret: '', token: '' }
    },
    scope: { answer: true, reserve: 'draft', order: 'draft', complaint: 'ack' },
    guards: [
      'Never state a price that is not in the official catalog. If an item/service is not listed, say you will check and a team member will confirm.',
      'Never invent items, services, false specifications, or medical advice.',
      'Never confirm an order, appointment, or reservation as final without human review.',
      'Never promise an unverified delivery timeline or discount.',
      'If you do not know something, say so plainly and offer to have a team member follow up.'
    ],
    esc: ['refund', 'complaint', 'manager', 'urgent', 'lawyer', 'press', 'ফেরত', 'অভিযোগ', 'ম্যানেজার'],
    runtime: { enabled: true, offHours: 'reply', fallbackText: 'Thanks for reaching out! Our team will review your request and get back to you shortly.' }
  };
}

/* ───────── Workspaces ───────── */
export function listWorkspaces() {
  return db.prepare(`
    SELECT w.*,
      (SELECT COUNT(*) FROM conversations c WHERE c.workspace_id = w.id) as conv_count,
      (SELECT COUNT(*) FROM channel_accounts ca WHERE ca.workspace_id = w.id AND ca.enabled = 1) as channel_count
    FROM workspaces w
    ORDER BY w.id ASC
  `).all();
}

export function createWorkspace(name) {
  const wsName = (name || 'New Business Account').trim();
  const info = db.prepare('INSERT INTO workspaces (name, created_at) VALUES (?, ?)').run(wsName, now());
  const newId = Number(info.lastInsertRowid);
  const cleanConf = makeCleanTemplate(wsName);
  saveWorkspaceConfig(newId, cleanConf);
  return { id: newId, name: wsName };
}

export function deleteWorkspace(id) {
  const wsId = Number(id);
  if (wsId === 1) throw new Error('Cannot delete default primary workspace.');
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId);
  db.prepare('DELETE FROM workspace_configs WHERE workspace_id = ?').run(wsId);
  db.prepare('DELETE FROM channel_accounts WHERE workspace_id = ?').run(wsId);
  db.prepare('DELETE FROM workspace_users WHERE workspace_id = ?').run(wsId);
  db.prepare('DELETE FROM subscriptions WHERE workspace_id = ?').run(wsId);
  return { ok: true };
}

export function renameWorkspace(id, name) {
  const wsId = Number(id);
  const wsName = (name || '').trim();
  if (!wsName) throw new Error('Workspace name cannot be empty.');
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(wsName, wsId);
  const cfg = getWorkspaceConfig(wsId);
  cfg.cafe = cfg.cafe || {};
  cfg.cafe.name = wsName;
  saveWorkspaceConfig(wsId, cfg);
  return { ok: true, id: wsId, name: wsName };
}

/* ───────── Config (Per-Workspace) ───────── */
export function getWorkspaceConfig(workspaceId = 1) {
  const wsId = Number(workspaceId) || 1;
  const row = db.prepare('SELECT json FROM workspace_configs WHERE workspace_id = ?').get(wsId);
  if (!row) {
    const fallback = wsId === 1 ? DEFAULT_CONFIG : makeCleanTemplate(`Workspace #${wsId}`);
    saveWorkspaceConfig(wsId, fallback);
    return structuredClone(fallback);
  }
  try {
    const parsed = JSON.parse(row.json);
    const template = wsId === 1 ? DEFAULT_CONFIG : makeCleanTemplate(parsed.cafe?.name || `Workspace #${wsId}`);
    
    // For primary workspace 1, preserve initial menu / faqs if empty
    if (wsId === 1) {
      const hasMenu = (parsed.menu || []).some(c => c.items?.length);
      if (!hasMenu && DEFAULT_CONFIG.menu?.length) {
        parsed.menu = structuredClone(DEFAULT_CONFIG.menu);
      }
      if ((!parsed.faqs || !parsed.faqs.length) && DEFAULT_CONFIG.faqs?.length) {
        parsed.faqs = structuredClone(DEFAULT_CONFIG.faqs);
      }
      if (DEFAULT_CONFIG.cafe) {
        for (const [k, v] of Object.entries(DEFAULT_CONFIG.cafe)) {
          if (!parsed.cafe?.[k] && v) {
            parsed.cafe = parsed.cafe || {};
            parsed.cafe[k] = v;
          }
        }
      }
    }

    parsed.channels = parsed.channels || {};
    for (const [ch, def] of Object.entries(template.channels || {})) {
      parsed.channels[ch] = { ...def, ...(parsed.channels[ch] || {}) };
      // Fallback to env vars only for Workspace 1
      if (wsId === 1) {
        for (const [k, v] of Object.entries(def)) {
          if (!parsed.channels[ch][k] && v) parsed.channels[ch][k] = v;
        }
      }
    }
    return { ...structuredClone(template), ...parsed };
  } catch {
    return wsId === 1 ? structuredClone(DEFAULT_CONFIG) : makeCleanTemplate(`Workspace #${wsId}`);
  }
}

export function saveWorkspaceConfig(workspaceId = 1, cfg) {
  const wsId = Number(workspaceId) || 1;
  db.prepare(`INSERT INTO workspace_configs (workspace_id, json, updated) VALUES (?, ?, ?)
              ON CONFLICT(workspace_id) DO UPDATE SET json = excluded.json, updated = excluded.updated`)
    .run(wsId, JSON.stringify(cfg), now());
  
  if (wsId === 1) {
    db.prepare(`INSERT INTO config (id, json, updated) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated = excluded.updated`)
      .run(JSON.stringify(cfg), now());
  }

  if (cfg.channels) {
    syncChannelAccounts(wsId, cfg.channels);
  }
}

export const getConfig = () => getWorkspaceConfig(1);
export const saveConfig = (cfg) => saveWorkspaceConfig(1, cfg);

/* ───────── Multi-Account Channel Sync & Routing ───────── */
export function syncChannelAccounts(workspaceId, channels) {
  const wsId = Number(workspaceId) || 1;
  if (!channels || typeof channels !== 'object') return;

  if (channels.facebook?.pageId && channels.facebook?.pageToken) {
    const pageId = String(channels.facebook.pageId).trim();
    const token = String(channels.facebook.pageToken).trim();
    const enabled = channels.facebook.enabled !== false ? 1 : 0;
    const json = JSON.stringify({ appSecret: channels.facebook.appSecret, verifyToken: channels.facebook.verifyToken });
    db.prepare(`INSERT INTO channel_accounts (workspace_id, platform, account_id, name, token, config_json, enabled, created_at)
                VALUES (?, 'facebook', ?, 'Facebook Page', ?, ?, ?, ?)
                ON CONFLICT(platform, account_id) DO UPDATE SET
                  workspace_id = excluded.workspace_id,
                  token = excluded.token,
                  config_json = excluded.config_json,
                  enabled = excluded.enabled`).run(wsId, pageId, token, json, enabled, now());
  }

  if (channels.instagram?.userId && channels.instagram?.token) {
    const userId = String(channels.instagram.userId).trim();
    const token = String(channels.instagram.token).trim();
    const enabled = channels.instagram.enabled !== false ? 1 : 0;
    const json = JSON.stringify({ graphHost: channels.instagram.graphHost });
    db.prepare(`INSERT INTO channel_accounts (workspace_id, platform, account_id, name, token, config_json, enabled, created_at)
                VALUES (?, 'instagram', ?, 'Instagram Account', ?, ?, ?, ?)
                ON CONFLICT(platform, account_id) DO UPDATE SET
                  workspace_id = excluded.workspace_id,
                  token = excluded.token,
                  config_json = excluded.config_json,
                  enabled = excluded.enabled`).run(wsId, userId, token, json, enabled, now());
  }

  if (channels.whatsapp?.phoneNumberId && channels.whatsapp?.token) {
    const phoneId = String(channels.whatsapp.phoneNumberId).trim();
    const token = String(channels.whatsapp.token).trim();
    const enabled = channels.whatsapp.enabled !== false ? 1 : 0;
    const json = JSON.stringify({ wabaId: channels.whatsapp.wabaId, verifyToken: channels.whatsapp.verifyToken });
    db.prepare(`INSERT INTO channel_accounts (workspace_id, platform, account_id, name, token, config_json, enabled, created_at)
                VALUES (?, 'whatsapp', ?, 'WhatsApp Business', ?, ?, ?, ?)
                ON CONFLICT(platform, account_id) DO UPDATE SET
                  workspace_id = excluded.workspace_id,
                  token = excluded.token,
                  config_json = excluded.config_json,
                  enabled = excluded.enabled`).run(wsId, phoneId, token, json, enabled, now());
  }

  if (channels.tiktok?.clientKey && channels.tiktok?.token) {
    const clientKey = String(channels.tiktok.clientKey).trim();
    const token = String(channels.tiktok.token).trim();
    const enabled = channels.tiktok.enabled !== false ? 1 : 0;
    const json = JSON.stringify({ clientSecret: channels.tiktok.clientSecret });
    db.prepare(`INSERT INTO channel_accounts (workspace_id, platform, account_id, name, token, config_json, enabled, created_at)
                VALUES (?, 'tiktok', ?, 'TikTok Business', ?, ?, ?, ?)
                ON CONFLICT(platform, account_id) DO UPDATE SET
                  workspace_id = excluded.workspace_id,
                  token = excluded.token,
                  config_json = excluded.config_json,
                  enabled = excluded.enabled`).run(wsId, clientKey, token, json, enabled, now());
  }
}

export function findAccountByPlatformAndId(platform, accountId) {
  if (!platform || !accountId) return null;
  const cleanId = String(accountId).trim();
  const row = db.prepare('SELECT * FROM channel_accounts WHERE platform = ? AND account_id = ? AND enabled = 1').get(platform, cleanId);
  return row || null;
}

export function listWorkspaceChannels(workspaceId) {
  const wsId = Number(workspaceId) || 1;
  return db.prepare('SELECT * FROM channel_accounts WHERE workspace_id = ?').all(wsId);
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
export function upsertConversation(platform, psid, name, workspaceId = 1) {
  const wsId = Number(workspaceId) || 1;
  db.prepare(`INSERT INTO conversations (platform, psid, name, workspace_id, last_msg_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(platform, psid) DO UPDATE SET
                last_msg_at = excluded.last_msg_at,
                workspace_id = COALESCE(conversations.workspace_id, excluded.workspace_id),
                name = COALESCE(excluded.name, conversations.name)`)
    .run(platform, psid, name || null, wsId, now(), now());
  return db.prepare('SELECT * FROM conversations WHERE platform = ? AND psid = ?').get(platform, psid);
}

export function listConversations(workspaceId = null) {
  if (workspaceId) {
    return db.prepare(`
      SELECT c.*, (SELECT text FROM messages m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) AS preview
      FROM conversations c
      WHERE c.workspace_id = ?
      ORDER BY c.flagged DESC, c.last_msg_at DESC LIMIT 200`).all(Number(workspaceId));
  }
  return db.prepare(`
    SELECT c.*, (SELECT text FROM messages m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) AS preview
    FROM conversations c
    ORDER BY c.flagged DESC, c.last_msg_at DESC LIMIT 200`).all();
}

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

export const addDraft = (convId, kind, details, workspaceId = 1) =>
  db.prepare('INSERT INTO drafts (workspace_id, conv_id, kind, details, created_at) VALUES (?,?,?,?,?)')
    .run(Number(workspaceId) || 1, convId, kind, details, now());

export function listDrafts(workspaceId = null) {
  if (workspaceId) {
    return db.prepare(`
      SELECT d.*, c.name, c.platform FROM drafts d JOIN conversations c ON c.id = d.conv_id
      WHERE d.status = 'pending' AND d.workspace_id = ? ORDER BY d.id DESC`).all(Number(workspaceId));
  }
  return db.prepare(`
    SELECT d.*, c.name, c.platform FROM drafts d JOIN conversations c ON c.id = d.conv_id
    WHERE d.status = 'pending' ORDER BY d.id DESC`).all();
}

export function createOrder(data = {}) {
  const wsId = Number(data.workspace_id || data.workspaceId) || 1;
  let convId = Number(data.conv_id || data.convId);
  if (!convId || isNaN(convId)) {
    convId = null;
  } else {
    try {
      const exists = db.prepare('SELECT id FROM conversations WHERE id = ?').get(convId);
      if (!exists) convId = null;
    } catch {
      convId = null;
    }
  }
  const platform = data.platform || 'web';
  const customerName = data.customer_name || data.customerName || '';
  const customerPhone = data.customer_phone || data.customerPhone || '';
  const customerAddress = data.customer_address || data.customerAddress || '';
  const details = data.details || '';
  const estimatedTotal = String(data.estimated_total || data.estimatedTotal || '');
  const notes = data.notes || '';

  const info = db.prepare(`
    INSERT INTO orders (workspace_id, conv_id, platform, customer_name, customer_phone, customer_address, details, estimated_total, status, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(wsId, convId, platform, customerName, customerPhone, customerAddress, details, estimatedTotal, notes, now());
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
}

export function listOrders(workspaceId, status = 'all') {
  const wsId = Number(workspaceId) || 1;
  if (status && status !== 'all') {
    return db.prepare('SELECT * FROM orders WHERE workspace_id = ? AND status = ? ORDER BY id DESC').all(wsId, status);
  }
  return db.prepare('SELECT * FROM orders WHERE workspace_id = ? ORDER BY id DESC').all(wsId);
}

export function updateOrderStatus(orderId, workspaceId, status, notes = null) {
  const wsId = Number(workspaceId);
  const id = Number(orderId);
  const confirmedAt = (status === 'confirmed' || status === 'rejected') ? now() : null;
  if (notes !== null) {
    db.prepare(`
      UPDATE orders SET status = ?, confirmed_at = ?, notes = ?
      WHERE id = ? AND workspace_id = ?
    `).run(status, confirmedAt, notes, id, wsId);
  } else {
    db.prepare(`
      UPDATE orders SET status = ?, confirmed_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(status, confirmedAt, id, wsId);
  }
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

export function getOrderStats(workspaceId) {
  const wsId = Number(workspaceId) || 1;
  const pending = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE workspace_id = ? AND status = 'pending'").get(wsId) || {}).n || 0;
  const confirmed = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE workspace_id = ? AND status = 'confirmed'").get(wsId) || {}).n || 0;
  const rejected = (db.prepare("SELECT COUNT(*) as n FROM orders WHERE workspace_id = ? AND status = 'rejected'").get(wsId) || {}).n || 0;
  const total = pending + confirmed + rejected;
  return { pending, confirmed, rejected, total };
}

export function stats(workspaceId = null) {
  const wsId = workspaceId ? Number(workspaceId) : null;
  const q = (s, ...args) => {
    try { return (db.prepare(s).get(...args) || {}).n || 0; }
    catch { return 0; }
  };
  
  let byPlatform = [];
  try {
    byPlatform = wsId
      ? db.prepare('SELECT platform, COUNT(*) as count FROM conversations WHERE workspace_id = ? GROUP BY platform').all(wsId)
      : db.prepare('SELECT platform, COUNT(*) as count FROM conversations GROUP BY platform').all();
  } catch {
    try { byPlatform = db.prepare('SELECT platform, COUNT(*) as count FROM conversations GROUP BY platform').all(); } catch {}
  }
  
  const platformCounts = { facebook: 0, instagram: 0, whatsapp: 0, tiktok: 0 };
  for (const row of byPlatform) {
    if (row.platform in platformCounts) platformCounts[row.platform] = row.count;
  }

  const aiReplies = wsId
    ? q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND (model IS NULL OR model != 'human') AND conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)", wsId)
    : q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND (model IS NULL OR model != 'human')");

  const humanReplies = wsId
    ? q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND model = 'human' AND conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)", wsId)
    : q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND model = 'human'");

  // Hourly message distribution for Dhaka time (+6 hours)
  let hourlyRows = [];
  try {
    const hourlySql = wsId
      ? `SELECT strftime('%H', datetime(created_at, '+6 hours')) as hour, COUNT(*) as count
         FROM messages
         WHERE date(datetime(created_at, '+6 hours')) = date('now', '+6 hours')
           AND conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)
         GROUP BY hour`
      : `SELECT strftime('%H', datetime(created_at, '+6 hours')) as hour, COUNT(*) as count
         FROM messages
         WHERE date(datetime(created_at, '+6 hours')) = date('now', '+6 hours')
         GROUP BY hour`;
    hourlyRows = wsId ? db.prepare(hourlySql).all(wsId) : db.prepare(hourlySql).all();
  } catch {}
  
  const hourlyMap = {};
  for (let i = 0; i < 24; i++) {
    const hStr = String(i).padStart(2, '0');
    hourlyMap[hStr] = 0;
  }
  for (const r of hourlyRows) {
    if (r.hour in hourlyMap) hourlyMap[r.hour] = r.count;
  }

  // Recent messages for live telemetry feed
  let recent = [];
  try {
    const recentSql = wsId
      ? `SELECT m.id, m.direction, m.text, m.model, m.created_at, c.platform, c.name, c.id as conv_id
         FROM messages m
         JOIN conversations c ON c.id = m.conv_id
         WHERE c.workspace_id = ?
         ORDER BY m.id DESC
         LIMIT 6`
      : `SELECT m.id, m.direction, m.text, m.model, m.created_at, c.platform, c.name, c.id as conv_id
         FROM messages m
         JOIN conversations c ON c.id = m.conv_id
         ORDER BY m.id DESC
         LIMIT 6`;
    recent = wsId ? db.prepare(recentSql).all(wsId) : db.prepare(recentSql).all();
  } catch {}

  return {
    conversations: wsId ? q('SELECT COUNT(*) n FROM conversations WHERE workspace_id = ?', wsId) : q('SELECT COUNT(*) n FROM conversations'),
    messagesIn:    wsId ? q("SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)", wsId) : q("SELECT COUNT(*) n FROM messages WHERE direction = 'in'"),
    messagesOut:   wsId ? q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)", wsId) : q("SELECT COUNT(*) n FROM messages WHERE direction = 'out'"),
    flagged:       wsId ? q('SELECT COUNT(*) n FROM conversations WHERE flagged = 1 AND workspace_id = ?', wsId) : q('SELECT COUNT(*) n FROM conversations WHERE flagged = 1'),
    today:         wsId ? q("SELECT COUNT(*) n FROM messages WHERE date(created_at, '+6 hours') = date('now', '+6 hours') AND conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)", wsId) : q("SELECT COUNT(*) n FROM messages WHERE date(created_at, '+6 hours') = date('now', '+6 hours')"),
    todayIn:       wsId ? q("SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND date(created_at, '+6 hours') = date('now', '+6 hours') AND conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)", wsId) : q("SELECT COUNT(*) n FROM messages WHERE direction = 'in' AND date(created_at, '+6 hours') = date('now', '+6 hours')"),
    todayOut:      wsId ? q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND date(created_at, '+6 hours') = date('now', '+6 hours') AND conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)", wsId) : q("SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND date(created_at, '+6 hours') = date('now', '+6 hours')"),
    aiReplies,
    humanReplies,
    byPlatform: platformCounts,
    hourly: hourlyMap,
    recent
  };
}

/* ───────── Tenant Auth & Subscription Helpers ───────── */

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const keyBuffer = Buffer.from(key, 'hex');
  const derivedKey = scryptSync(password, salt, 64);
  return timingSafeEqual(keyBuffer, derivedKey);
}

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') || 'client';
}

export function isPasswordUnique(password, excludeUserId = null) {
  const pwd = String(password || '').trim();
  if (!pwd) return false;
  // Master Admin reserved
  if (pwd === 'ccadmin6789') return false;
  // Crown Coffee (Workspace #1) reserved unless updating tenant #1
  if (pwd === '1590') {
    if (excludeUserId === null) return false;
    const user1 = db.prepare('SELECT id FROM workspace_users WHERE workspace_id = 1').get();
    if (!user1 || Number(excludeUserId) !== user1.id) return false;
  }

  const users = db.prepare('SELECT id, password_hash FROM workspace_users').all();
  for (const u of users) {
    if (excludeUserId && u.id === Number(excludeUserId)) continue;
    if (verifyPassword(pwd, u.password_hash)) {
      return false;
    }
  }
  return true;
}

export function createWorkspaceWithTenant(name, monthlyFee = 500, contactEmail = '', customPassword = null, businessType = 'General Business', services = '') {
  const ws = createWorkspace(name);
  const slug = slugify(name);
  let defaultEmail = contactEmail ? String(contactEmail).trim().toLowerCase() : `admin@${slug}.com`;
  const existingEmail = db.prepare('SELECT id FROM workspace_users WHERE LOWER(email) = LOWER(?)').get(defaultEmail);
  if (existingEmail) {
    defaultEmail = `admin@${slug}-${ws.id}.com`;
  }
  
  let chosenPassword = customPassword ? String(customPassword).trim() : null;
  if (chosenPassword) {
    if (!isPasswordUnique(chosenPassword)) {
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
      throw new Error('This password is already in use by another account or reserved. Please choose a unique password.');
    }
  } else {
    let candidate = '';
    let attempts = 0;
    do {
      attempts++;
      const rand = Math.floor(1000 + Math.random() * 9000);
      candidate = `${slug}@${rand}`;
    } while (!isPasswordUnique(candidate) && attempts < 50);
    chosenPassword = candidate;
  }

  const pHash = hashPassword(chosenPassword);

  try {
    db.prepare(`
      INSERT INTO workspace_users (workspace_id, email, password_hash, password_display, must_change_password, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 'tenant_admin', ?, ?)
    `).run(ws.id, defaultEmail, pHash, chosenPassword, now(), now());

    const trialEnds = new Date(Date.now() + 14 * 86400 * 1000).toISOString();
    db.prepare(`
      INSERT INTO subscriptions (workspace_id, status, plan_name, trial_ends_at, active_until, monthly_fee, contact_email, notes, updated_at)
      VALUES (?, 'trial', '14-Day Free Trial', ?, NULL, ?, ?, '', ?)
    `).run(ws.id, trialEnds, Number(monthlyFee) || 500, defaultEmail, now());

    // Save customized clean template with businessType and services
    const tpl = makeCleanTemplate(name, businessType, services);
    saveWorkspaceConfig(ws.id, tpl);

    return {
      workspace: ws,
      credentials: {
        email: defaultEmail,
        password: chosenPassword
      },
      subscription: getSubscription(ws.id)
    };
  } catch (err) {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
    throw err;
  }
}

export function authenticateTenant(email, password) {
  if (!email || !password) return null;
  const user = db.prepare('SELECT * FROM workspace_users WHERE LOWER(email) = LOWER(?)').get(String(email).trim());
  if (!user) return null;
  const ok = verifyPassword(String(password), user.password_hash);
  if (!ok) return null;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(user.workspace_id);
  if (!ws) return null;
  return {
    id: user.id,
    workspace_id: user.workspace_id,
    workspace_name: ws.name,
    email: user.email,
    must_change_password: !!user.must_change_password,
    role: user.role
  };
}

export function updateTenantCredentials(userId, newEmail, newPassword = null) {
  const user = db.prepare('SELECT * FROM workspace_users WHERE id = ?').get(userId);
  if (!user) throw new Error('Tenant user not found.');

  const emailVal = newEmail ? String(newEmail).trim().toLowerCase() : user.email;

  // Check unique email
  if (emailVal !== user.email) {
    const existing = db.prepare('SELECT id FROM workspace_users WHERE LOWER(email) = ? AND id != ?').get(emailVal, userId);
    if (existing) throw new Error('Email is already in use by another tenant.');
  }

  if (newPassword && String(newPassword).trim().length >= 4) {
    const pwd = String(newPassword).trim();
    if (!isPasswordUnique(pwd, userId)) {
      throw new Error('This password is already in use by another account or reserved. Please choose a unique password.');
    }
    const pHash = hashPassword(pwd);
    db.prepare('UPDATE workspace_users SET email = ?, password_hash = ?, password_display = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(emailVal, pHash, pwd, now(), userId);
  } else {
    db.prepare('UPDATE workspace_users SET email = ?, updated_at = ? WHERE id = ?')
      .run(emailVal, now(), userId);
  }

  // Update contact email in subscriptions
  db.prepare('UPDATE subscriptions SET contact_email = ?, updated_at = ? WHERE workspace_id = ?').run(emailVal, now(), user.workspace_id);

  return { ok: true, email: emailVal };
}

export function resetTenantPassword(workspaceId, newPassword = null) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!ws) throw new Error('Workspace not found.');
  const user = db.prepare('SELECT * FROM workspace_users WHERE workspace_id = ?').get(workspaceId);
  const slug = slugify(ws.name);

  let pwd = newPassword ? String(newPassword).trim() : null;
  if (pwd) {
    if (!isPasswordUnique(pwd, user ? user.id : null)) {
      throw new Error('This password is already in use by another account or reserved. Please choose a unique password.');
    }
  } else {
    let candidate = '';
    let attempts = 0;
    do {
      attempts++;
      const rand = Math.floor(1000 + Math.random() * 9000);
      candidate = `${slug}@${rand}`;
    } while (!isPasswordUnique(candidate) && attempts < 50);
    pwd = candidate;
  }

  const pHash = hashPassword(pwd);

  if (user) {
    db.prepare('UPDATE workspace_users SET password_hash = ?, password_display = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(pHash, pwd, now(), user.id);
  } else {
    const defaultEmail = `admin@${slug}.com`;
    db.prepare(`
      INSERT INTO workspace_users (workspace_id, email, password_hash, password_display, must_change_password, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 'tenant_admin', ?, ?)
    `).run(workspaceId, defaultEmail, pHash, pwd, now(), now());
  }

  return { ok: true, password: pwd };
}

export function getTenantUser(workspaceId) {
  return db.prepare('SELECT id, workspace_id, email, password_display, must_change_password, role, created_at, updated_at FROM workspace_users WHERE workspace_id = ?')
    .get(workspaceId);
}

export function getSubscription(workspaceId) {
  const wsId = Number(workspaceId) || 1;
  let sub = db.prepare('SELECT * FROM subscriptions WHERE workspace_id = ?').get(wsId);
  if (!sub) {
    if (wsId === 1) {
      const activeUntil = '2099-12-31T23:59:59.000Z';
      db.prepare(`
        INSERT INTO subscriptions (workspace_id, status, plan_name, trial_ends_at, active_until, monthly_fee, contact_email, updated_at)
        VALUES (1, 'active', 'Flagship Lifetime', ?, ?, 0, 'admin@crowncoffee.com', ?)
      `).run(activeUntil, activeUntil, now());
      sub = db.prepare('SELECT * FROM subscriptions WHERE workspace_id = 1').get();
    } else {
      const trialEnds = new Date(Date.now() + 14 * 86400 * 1000).toISOString();
      db.prepare(`
        INSERT INTO subscriptions (workspace_id, status, plan_name, trial_ends_at, active_until, monthly_fee, contact_email, updated_at)
        VALUES (?, 'trial', '14-Day Free Trial', ?, NULL, 500, '', ?)
      `).run(wsId, trialEnds, now());
      sub = db.prepare('SELECT * FROM subscriptions WHERE workspace_id = ?').get(wsId);
    }
  }

  const nowMs = Date.now();
  let daysRemaining = 0;
  let isExpired = false;
  let isActive = false;

  if (sub.status === 'suspended') {
    isExpired = true;
    isActive = false;
  } else if (sub.status === 'active') {
    if (sub.active_until) {
      const endMs = new Date(sub.active_until).getTime();
      daysRemaining = Math.max(0, Math.ceil((endMs - nowMs) / (86400 * 1000)));
      if (endMs < nowMs) {
        isExpired = true;
        isActive = false;
        db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE workspace_id = ?").run(now(), wsId);
        sub.status = 'expired';
      } else {
        isActive = true;
      }
    } else {
      isActive = true;
      daysRemaining = 999;
    }
  } else if (sub.status === 'trial') {
    const endMs = new Date(sub.trial_ends_at).getTime();
    daysRemaining = Math.max(0, Math.ceil((endMs - nowMs) / (86400 * 1000)));
    if (endMs < nowMs) {
      isExpired = true;
      isActive = false;
      db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE workspace_id = ?").run(now(), wsId);
      sub.status = 'expired';
    } else {
      isActive = true;
    }
  } else if (sub.status === 'expired') {
    isExpired = true;
    isActive = false;
  }

  return {
    ...sub,
    daysRemaining,
    isExpired,
    isActive
  };
}

export function isSubscriptionActive(workspaceId) {
  const wsId = Number(workspaceId) || 1;
  if (wsId === 1) return true; // Flagship always active
  const sub = getSubscription(wsId);
  return sub.isActive && !sub.isExpired;
}

export function updateSubscription(workspaceId, data = {}) {
  const wsId = Number(workspaceId);
  const current = getSubscription(wsId);
  const status = data.status || current.status;
  const planName = data.plan_name !== undefined ? data.plan_name : current.plan_name;
  const trialEndsAt = data.trial_ends_at !== undefined ? data.trial_ends_at : current.trial_ends_at;
  const activeUntil = data.active_until !== undefined ? data.active_until : current.active_until;
  const monthlyFee = data.monthly_fee !== undefined ? Number(data.monthly_fee) : current.monthly_fee;
  const contactEmail = data.contact_email !== undefined ? data.contact_email : current.contact_email;
  const contactPhone = data.contact_phone !== undefined ? data.contact_phone : current.contact_phone;
  const notes = data.notes !== undefined ? data.notes : current.notes;

  db.prepare(`
    UPDATE subscriptions SET
      status = ?, plan_name = ?, trial_ends_at = ?, active_until = ?,
      monthly_fee = ?, contact_email = ?, contact_phone = ?, notes = ?, updated_at = ?
    WHERE workspace_id = ?
  `).run(status, planName, trialEndsAt, activeUntil, monthlyFee, contactEmail, contactPhone, notes, now(), wsId);

  return getSubscription(wsId);
}

export function listTenantsOverview() {
  const workspaces = listWorkspaces();
  return workspaces.map(ws => {
    const user = getTenantUser(ws.id);
    const sub = getSubscription(ws.id);
    const orderStats = getOrderStats(ws.id);
    const convCount = (db.prepare('SELECT COUNT(*) as n FROM conversations WHERE workspace_id = ?').get(ws.id) || {}).n || 0;
    const msgCount = (db.prepare('SELECT COUNT(*) as n FROM messages m JOIN conversations c ON c.id = m.conv_id WHERE c.workspace_id = ?').get(ws.id) || {}).n || 0;
    return {
      workspace: ws,
      user: user || { email: `admin@${slugify(ws.name)}.com`, must_change_password: 0, password_display: '---' },
      subscription: sub,
      orderStats,
      stats: {
        conversations: convCount,
        messages: msgCount
      }
    };
  });
}

/* ───────── Initializer ───────── */
try {
  const defaultWs = db.prepare('SELECT * FROM workspaces WHERE id = 1').get();
  if (!defaultWs) {
    db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (1, ?, ?)').run('Crown Coffee (Default)', now());
  }
} catch (e) {
  // table exists
}

try {
  const ws1 = db.prepare('SELECT * FROM workspace_configs WHERE workspace_id = 1').get();
  if (!ws1) {
    const old = db.prepare('SELECT json, updated FROM config WHERE id = 1').get();
    if (old) {
      db.prepare('INSERT INTO workspace_configs (workspace_id, json, updated) VALUES (1, ?, ?)').run(old.json, old.updated);
    } else {
      db.prepare('INSERT INTO workspace_configs (workspace_id, json, updated) VALUES (1, ?, ?)').run(JSON.stringify(DEFAULT_CONFIG), now());
    }
  }
} catch (e) {
  // table exists
}

export function authenticateTenantByPasswordOnly(password) {
  if (!password) return null;
  const pwd = String(password).trim();
  const users = db.prepare('SELECT * FROM workspace_users').all();
  for (const u of users) {
    if (verifyPassword(pwd, u.password_hash)) {
      const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(u.workspace_id);
      if (!ws) continue;
      return {
        id: u.id,
        workspace_id: u.workspace_id,
        workspace_name: ws.name,
        email: u.email,
        must_change_password: !!u.must_change_password,
        role: u.role
      };
    }
  }
  return null;
}

// Seed or Update Workspace #1 Tenant User (Password: 1590)
try {
  const user1 = db.prepare('SELECT * FROM workspace_users WHERE workspace_id = 1').get();
  const pHash = hashPassword('1590');
  if (!user1) {
    db.prepare(`
      INSERT INTO workspace_users (workspace_id, email, password_hash, password_display, must_change_password, role, created_at, updated_at)
      VALUES (1, 'tenant@crowncoffee.local', ?, '1590', 0, 'tenant_admin', ?, ?)
    `).run(pHash, now(), now());
  } else {
    db.prepare(`
      UPDATE workspace_users SET email = 'tenant@crowncoffee.local', password_hash = ?, password_display = '1590', must_change_password = 0, updated_at = ?
      WHERE workspace_id = 1
    `).run(pHash, now());
  }
} catch (e) {
  // table exists
}

try {
  getSubscription(1);
} catch (e) {
  // init sub
}

try {
  const cfg1 = getWorkspaceConfig(1);
  if (cfg1.channels) syncChannelAccounts(1, cfg1.channels);
} catch (e) {
  // channel sync
}


