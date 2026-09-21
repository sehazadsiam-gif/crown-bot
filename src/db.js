import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

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

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_ws ON push_subscriptions(workspace_id);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id    INTEGER NOT NULL DEFAULT 1,
  platform        TEXT NOT NULL,
  event_type      TEXT NOT NULL DEFAULT 'message',
  payload_preview TEXT,
  status          TEXT NOT NULL DEFAULT 'ok',
  error           TEXT,
  received_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whl_ws ON webhook_logs(workspace_id, received_at);
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

try {
  const wsCols = db.pragma('table_info(workspaces)');
  if (!wsCols.some(c => c.name === 'custom_domain')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN custom_domain TEXT');
  }
} catch (e) {
  console.error('Migration warning (workspaces.custom_domain):', e.message);
}

const now = () => new Date().toISOString();

/* ───────── config ───────── */
export const DEFAULT_CONFIG = {
  cafe: {
    name: 'CC',
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
    greeting: 'Assalamu Alaikum! Welcome to CC.',
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

export function getIndustryPresets(businessName = 'New Business', businessType = 'General Business', services = '') {
  const normType = String(businessType || '').toLowerCase();
  const name = businessName || 'Our Business';

  // 1. DENTISTRY & DENTAL CLINIC
  if (normType.includes('dent') || normType.includes('dental') || normType.includes('smile') || normType.includes('tooth') || normType.includes('teeth') || normType.includes('orthodont')) {
    return {
      serviceDesc: services || 'Comprehensive dental consultations, scaling, root canal therapy, tooth-colored fillings, cosmetic whitening, crowns, and oral surgery',
      holidayNote: 'Open during regular clinic hours. Pre-scheduled appointments recommended.',
      deliveryApps: 'Tele-consultation, Digital Rx',
      menu: [
        {
          id: 'cat_prev',
          name: 'Diagnostic & Preventive Care',
          items: [
            { id: 'd1', name: 'Comprehensive Dental Examination', desc: 'Oral clinical examination, oral cancer screening & treatment plan', price: 500, available: true },
            { id: 'd2', name: 'Digital Dental X-Ray (IOPA)', desc: 'High-definition digital diagnostic periapical radiograph', price: 300, available: true },
            { id: 'd3', name: 'Teeth Scaling & Deep Polishing', desc: 'Full mouth ultrasonic plaque, calculus & stain removal', price: 1500, available: true }
          ]
        },
        {
          id: 'cat_endo',
          name: 'Restorative & Endodontics',
          items: [
            { id: 'd4', name: 'Composite Tooth Filling', desc: 'Aesthetic light-cured resin filling matched to natural shade', price: 1200, available: true },
            { id: 'd5', name: 'Root Canal Treatment (Front Tooth)', desc: 'Complete painless single-canal endodontic therapy', price: 4000, available: true },
            { id: 'd6', name: 'Root Canal Treatment (Molar)', desc: 'Complex multi-canal molar therapy using rotary files', price: 6000, available: true }
          ]
        },
        {
          id: 'cat_cosm',
          name: 'Cosmetics & Crowns',
          items: [
            { id: 'd7', name: 'Laser In-Office Teeth Whitening', desc: 'Professional clinical shade-brightening laser session', price: 8000, available: true },
            { id: 'd8', name: 'Porcelain Fused to Metal (PFM) Crown', desc: 'High-strength aesthetic ceramic crown with metal core', price: 6500, available: true },
            { id: 'd9', name: 'Zirconia All-Ceramic Crown', desc: 'Premium computer-milled metal-free biocompatible crown', price: 12000, available: true }
          ]
        },
        {
          id: 'cat_surg',
          name: 'Oral Surgery & Orthodontics',
          items: [
            { id: 'd10', name: 'Painless Tooth Extraction', desc: 'Simple clinical extraction with local anesthesia', price: 1000, available: true },
            { id: 'd11', name: 'Surgical Wisdom Tooth Removal', desc: 'Minor surgical removal of impacted third molar', price: 5000, available: true },
            { id: 'd12', name: 'Orthodontic Braces Consultation', desc: 'Malocclusion assessment, bite analysis & treatment plan', price: 1000, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What dental treatments and services are offered at ${name}?`, a: `We provide comprehensive dental care including routine checkups, ultrasonic teeth scaling and polishing, composite fillings, root canal therapy, porcelain and zirconia crowns, laser teeth whitening, orthodontic consultations, and oral surgery.` },
        { q: `How can I schedule an appointment with a dentist?`, a: `You can book an appointment by sending us a message here with your preferred day and time, or by calling our clinic reception. Our team will verify doctor availability and confirm your booking promptly.` },
        { q: `What are your consultation fees and treatment costs?`, a: `Initial doctor consultation starts from Tk 500. Specific treatment fees depend on clinical assessment and diagnostic X-rays. We provide a transparent, itemized estimate prior to starting any procedure.` },
        { q: `Where is the clinic located and what are your operating hours?`, a: `We are open Saturday through Thursday from 10:00 AM to 8:00 PM, and Fridays from 4:00 PM to 9:00 PM. Prior appointment booking is recommended to minimize waiting time.` },
        { q: `Do you accommodate emergency dental visits for severe toothache?`, a: `Yes, we prioritize acute dental emergencies such as severe tooth pain, fractured teeth, oral trauma, or facial swelling. Please contact us immediately so our clinical team can arrange immediate care.` },
        { q: `What payment options are accepted at ${name}?`, a: `We accept Cash, major Credit and Debit cards (Visa, Mastercard), and Mobile Banking (bKash and Nagad).` }
      ]
    };
  }

  // 2. MEDICAL CLINIC, DOCTOR & HEALTHCARE
  if (normType.includes('clinic') || normType.includes('health') || normType.includes('doctor') || normType.includes('medic') || normType.includes('hospital') || normType.includes('physician') || normType.includes('pharma')) {
    return {
      serviceDesc: services || 'Specialist doctor consultations, diagnostic health screenings, pathology testing, and outpatient clinical care',
      holidayNote: 'Open during clinic hours. Pre-scheduled appointments recommended for specialist chambers.',
      deliveryApps: 'Telemedicine, Home Sample Collection',
      menu: [
        {
          id: 'cat_med_cons',
          name: 'Specialist Doctor Chambers',
          items: [
            { id: 'm1', name: 'General Physician Consultation', desc: 'Primary diagnosis, health assessment and prescription', price: 800, available: true },
            { id: 'm2', name: 'Specialist Doctor Consultation', desc: 'Consultation with senior specialist (Medicine / Cardiology / Dermatology / Pediatrics)', price: 1200, available: true },
            { id: 'm3', name: 'Pediatric Child Health Examination', desc: 'Growth tracking, newborn screening and pediatric care', price: 1000, available: true }
          ]
        },
        {
          id: 'cat_med_diag',
          name: 'Diagnostic Tests & Lab Investigations',
          items: [
            { id: 'm4', name: 'Complete Blood Count (CBC) with ESR', desc: 'Automated 5-part hematology screening', price: 500, available: true },
            { id: 'm5', name: 'Lipid Profile & Blood Glucose Test', desc: 'Cholesterol, HDL, LDL, triglycerides and fasting sugar test', price: 900, available: true },
            { id: 'm6', name: '12-Lead Electrocardiogram (ECG)', desc: 'Cardiological electrical activity examination with report', price: 600, available: true }
          ]
        },
        {
          id: 'cat_med_care',
          name: 'Outpatient Nursing & Minor Procedures',
          items: [
            { id: 'm7', name: 'Aseptic Wound Dressing & Care', desc: 'Sterile surgical wound dressing and cleaning', price: 800, available: true },
            { id: 'm8', name: 'Nebulization Respiratory Therapy', desc: 'Bronchodilator aerosol therapy session for acute asthma/cough', price: 300, available: true },
            { id: 'm9', name: 'IV Cannulation & Fluid Infusion', desc: 'Intravenous drip administration by licensed nurse', price: 600, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What doctor specialties and medical services are available at ${name}?`, a: `We provide consultations across General Medicine, Pediatrics, Dermatology, Cardiology, Gynecology, and ENT, along with clinical diagnostics, routine pathology tests, and outpatient nursing care.` },
        { q: `How do I book a doctor appointment or reserve a serial?`, a: `You can message us directly here with the doctor specialty or doctor name and preferred date. Our reception team will reserve your serial number and send you confirmation details.` },
        { q: `What are your doctor consultation fees and diagnostic charges?`, a: `General physician consultation is Tk 800, and specialist chamber consultations range from Tk 1,000 to Tk 1,500. Diagnostic test fees follow standardized lab tariffs with no hidden charges.` },
        { q: `How and when can I collect my diagnostic lab reports?`, a: `Routine blood test and urine test reports are available the same day within 4 to 6 hours. Reports can be collected physically from our reception or delivered electronically to your WhatsApp/Email.` },
        { q: `Do you provide telemedicine or online video doctor consultations?`, a: `Yes, we offer scheduled telemedicine video consultations for follow-ups and non-emergency medical inquiries. Digital prescriptions are provided immediately after the call.` },
        { q: `What are your clinic hours and emergency medical policies?`, a: `Our clinic and diagnostic center operate Saturday through Thursday from 8:00 AM to 10:00 PM, and Fridays from 4:00 PM to 9:00 PM. For critical acute emergencies, please visit the nearest hospital emergency room.` }
      ]
    };
  }

  // 3. SALON, SPA & BEAUTY CARE
  if (normType.includes('salon') || normType.includes('spa') || normType.includes('parlour') || normType.includes('parlor') || normType.includes('beauty') || normType.includes('hair') || normType.includes('makeup') || normType.includes('skin') || normType.includes('aesthetic')) {
    return {
      serviceDesc: services || 'Hair styling, keratin treatments, radiant facials, bridal & party makeup, manicure, pedicure, and luxury body spa',
      holidayNote: 'Open all week. Advance booking recommended for bridal packages and weekends.',
      deliveryApps: 'Home Grooming Services, Beauty Packages',
      menu: [
        {
          id: 'cat_hair',
          name: 'Hair Styling & Treatments',
          items: [
            { id: 's1', name: 'Precision Haircut, Wash & Blowdry', desc: 'Custom style consultation, hair wash, conditioning and blowout', price: 600, available: true },
            { id: 's2', name: 'Keratin Protein Treatment', desc: 'Frizz reduction, intensive hair repair and long-lasting smoothness', price: 3500, available: true },
            { id: 's3', name: 'Organic Herbal Hair Spa', desc: 'Deep scalp massage, nourishing mask and steam infusion', price: 1500, available: true }
          ]
        },
        {
          id: 'cat_skin',
          name: 'Facial & Skincare Therapies',
          items: [
            { id: 's4', name: 'Bridal Radiance Glow Facial', desc: 'Multi-step skin brightening, gentle exfoliation and gold peel-off mask', price: 2500, available: true },
            { id: 's5', name: 'Deep Pore Cleansing & Acne Control', desc: 'Ultrasound extraction, clarifying mask and high-frequency therapy', price: 1800, available: true },
            { id: 's6', name: 'Vitamin C Hydrating Glow Facial', desc: 'Intensive skin hydration, antioxidant serum infusion and radiance massage', price: 2200, available: true }
          ]
        },
        {
          id: 'cat_makeup',
          name: 'Bridal & Party Makeover Packages',
          items: [
            { id: 's7', name: 'Signature Party Glam Makeup', desc: 'Full party makeup, false lashes, eye styling, and hair design', price: 3000, available: true },
            { id: 's8', name: 'Deluxe Bridal Makeover Package', desc: 'Premium HD bridal makeup, jewelry setting, dupatta drape, and hairstyling', price: 10000, available: true },
            { id: 's9', name: 'Engagement & Holud Makeup Package', desc: 'Vibrant theme makeup, floral accessory draping, and hairstyle', price: 6000, available: true }
          ]
        },
        {
          id: 'cat_nails',
          name: 'Nails & Relaxation Spa',
          items: [
            { id: 's10', name: 'Deluxe Spa Manicure & Pedicure', desc: 'Sea salt scrub, cuticle grooming, moisturizing massage, and polish', price: 1200, available: true },
            { id: 's11', name: 'Gel Nail Polish & Extension', desc: 'Durable chip-free gel polish application with nail art options', price: 2500, available: true },
            { id: 's12', name: 'Aromatherapy Stress Relief Massage', desc: 'Essential oil massage targeting neck, back, and shoulders (45 mins)', price: 2000, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What beauty, hair, and spa services are offered at ${name}?`, a: `We provide luxury hair styling, keratin and protein treatments, clinical and herbal facials, bridal and party makeup packages, spa manicures/pedicures, nail extensions, and relaxing body massages.` },
        { q: `How do I book an appointment and do you accept walk-ins?`, a: `We welcome both appointments and walk-ins. However, we strongly recommend pre-booking your slot by messaging us here to avoid waiting, especially on weekends and wedding season.` },
        { q: `What bridal makeup packages are available and what is included?`, a: `Our bridal packages include high-definition (HD) bridal makeup, customized hairstyle, jewelry placement, saree/lehenga draping, and pre-bridal skin prep. Touch-ups are also provided.` },
        { q: `What brands of cosmetics and hair products do you use?`, a: `We use only 100% genuine, internationally certified premium brands (including MAC, Huda Beauty, NARS, L'Oréal Professional, and Olaplex). All equipment is strictly sanitized.` },
        { q: `What is your rescheduling or cancellation policy?`, a: `Please notify us at least 4 hours in advance for general grooming services, or 48 hours in advance for bridal packages, so we can adjust our makeup artist schedules.` },
        { q: `What are your accepted payment methods at ${name}?`, a: `We accept Cash, major Credit and Debit Cards (Visa, Mastercard), bKash, and Nagad.` }
      ]
    };
  }

  // 4. LAW FIRM, LEGAL CONSULTANCY & ADVOCATES
  if (normType.includes('law') || normType.includes('legal') || normType.includes('advocate') || normType.includes('barrister') || normType.includes('attorney') || normType.includes('solicitor') || normType.includes('justice')) {
    return {
      serviceDesc: services || 'Corporate law, civil property litigation, contract drafting, family law, criminal defense, and legal chamber advisory',
      holidayNote: 'Chamber open Saturday to Thursday. Appointments strictly scheduled in advance.',
      deliveryApps: 'Online Legal Chamber, Digital Document Review',
      menu: [
        {
          id: 'cat_law_cons',
          name: 'Legal Chamber Consultations',
          items: [
            { id: 'l1', name: 'Initial Case Assessment & Consultation', desc: 'Comprehensive case review, legal merits evaluation, and preliminary advice', price: 2000, available: true },
            { id: 'l2', name: 'Senior Advocate Chamber Consultation', desc: 'In-depth strategic legal consultation with senior counsel (1 Hour)', price: 5000, available: true },
            { id: 'l3', name: 'Corporate Legal Retainer (Monthly)', desc: 'Ongoing business compliance, contract reviews, and corporate advisory', price: 25000, available: true }
          ]
        },
        {
          id: 'cat_law_draft',
          name: 'Contract Drafting & Documentation',
          items: [
            { id: 'l4', name: 'Commercial Agreement / Contract Drafting', desc: 'Bespoke drafting of partnership, vendor, lease, or employment contracts', price: 5000, available: true },
            { id: 'l5', name: 'Formal Legal Notice Drafting & Service', desc: 'Drafting and formal dispatch of statutory legal demand notice', price: 3000, available: true },
            { id: 'l6', name: 'Property Deed & Power of Attorney Vetting', desc: 'Title deed search, RAJUK clearance, and legal verification report', price: 4000, available: true }
          ]
        },
        {
          id: 'cat_law_court',
          name: 'Court Litigation & Dispute Resolution',
          items: [
            { id: 'l7', name: 'Civil & Property Dispute Representation', desc: 'Filing, pleadings, and court representation for property and land claims', price: 15000, available: true },
            { id: 'l8', name: 'Criminal Defense & Bail Hearing', desc: 'Filing bail petitions and representation before Magistrates and Sessions Court', price: 20000, available: true },
            { id: 'l9', name: 'Family & Matrimonial Law Dispute', desc: 'Divorce, custody, maintenance, and family court dispute representation', price: 10000, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What areas of law does ${name} practice?`, a: `Our firm provides full legal services across Corporate & Commercial Law, Civil Property & Real Estate Disputes, Contract Drafting & Vetting, Family & Matrimonial Law, and Criminal Defense Litigation.` },
        { q: `How can I schedule a consultation with an advocate or barrister?`, a: `You can schedule a consultation by messaging us here with a brief description of your legal matter and preferred day/time. Our chamber clerk will confirm your consultation slot.` },
        { q: `What are your consultation fees and billing structure?`, a: `Initial legal consultations start at Tk 2,000. For court litigation, documentation, or ongoing corporate retainers, we provide a formal fee proposal outlining milestone-based retainers and court filing expenses.` },
        { q: `Is my consultation and case information kept confidential?`, a: `Yes, absolutely. All communications, documents, and consultations are protected by strict attorney-client privilege and professional ethics confidentiality.` },
        { q: `Can you review my property documents or commercial contract online?`, a: `Yes, you can securely email or upload your contracts or property deeds. Our legal team will review the documents and provide a comprehensive written vetting opinion within 48 to 72 hours.` },
        { q: `Do you provide urgent representation for arrest or bail matters?`, a: `Yes, our litigation department handles emergency bail applications and urgent legal interventions. Please contact our hotline immediately for time-sensitive court matters.` }
      ]
    };
  }

  // 5. REAL ESTATE & PROPERTY MANAGEMENT
  if (normType.includes('real estate') || normType.includes('property') || normType.includes('properties') || normType.includes('developer') || normType.includes('apartment') || normType.includes('housing') || normType.includes('realty')) {
    return {
      serviceDesc: services || 'Residential apartments, luxury duplexes, commercial office spaces, planned plots, and property investment advisory',
      holidayNote: 'Site visits arranged 7 days a week including Fridays. Prior appointment required.',
      deliveryApps: 'Virtual 3D Tours, Digital Property Brochure',
      menu: [
        {
          id: 'cat_re_res',
          name: 'Residential Apartments & Flats',
          items: [
            { id: 're1', name: 'Ready 3-BHK Luxury Apartment Viewing', desc: '1,650 sq ft 3-bed 3-bath luxury apartment with parking', price: 0, available: true },
            { id: 're2', name: 'Under-Construction 2-BHK Modern Flat', desc: '1,100 sq ft smart design apartment with flexible payment plan', price: 4500000, available: true },
            { id: 're3', name: 'Duplex Penthouse Villa Consultation', desc: '3,200 sq ft rooftop penthouse with panoramic city view', price: 0, available: true }
          ]
        },
        {
          id: 'cat_re_com',
          name: 'Commercial & Corporate Properties',
          items: [
            { id: 're4', name: 'Prime Retail Showroom Space', desc: 'Ground floor road-facing retail commercial showroom for sale/lease', price: 8500000, available: true },
            { id: 're5', name: 'Corporate Office Floor Lease', desc: '3,500 sq ft open floor office space in Grade-A commercial tower', price: 120000, available: true }
          ]
        },
        {
          id: 'cat_re_land',
          name: 'Planned Residential Plots',
          items: [
            { id: 're6', name: '5 Katha Approved Residential Plot', desc: 'Demarcated south-facing plot with electricity, water and wide road access', price: 3500000, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What residential and commercial properties are currently available at ${name}?`, a: `We offer ready and ongoing luxury residential apartments (2-BHK, 3-BHK, duplexes), commercial office floors, prime retail spaces, and approved residential plots in top locations.` },
        { q: `How do I book a site visit or property inspection?`, a: `You can schedule a free guided site visit by sending us a message here with your preferred property location, day, and contact number. Our property consultant will escort you.` },
        { q: `What are your booking terms, installment plans, and down payment requirements?`, a: `Properties can be reserved with a 10% to 20% booking token. The remaining balance can be settled through convenient monthly or quarterly installment schedules up to handover.` },
        { q: `Are your projects approved by RAJUK and have clear legal title deeds?`, a: `Yes, all our projects hold 100% undisputed land ownership, CS/SA/RS/BS mutation clearance, RAJUK approved structural and architectural drawings, and fire safety clearance.` },
        { q: `Do you provide assistance with home loans and bank mortgages?`, a: `Yes, we have institutional tie-ups with leading banks and financial institutions (such as DBH, IDLC, BRAC Bank) offering expedited home loan processing with competitive interest rates.` },
        { q: `What is the expected handover timeline and developer warranty?`, a: `Handover dates are formally specified in the sales contract with guaranteed timelines. We provide 1 year of free structural and operational defect liability warranty post-handover.` }
      ]
    };
  }

  // 6. E-COMMERCE & RETAIL / CLOTHING & FASHION
  if ((normType.includes('ecommerce') || normType.includes('e-commerce') || normType.includes('clothing') || normType.includes('fashion') || normType.includes('boutique') || /\b(shop|shops|retail|apparel|store|stores)\b/.test(normType)) && !normType.includes('workshop')) {
    return {
      serviceDesc: services || 'Trendy fashion apparel, premium cotton menswear, elegant womenswear, footwear, accessories, and nationwide home delivery',
      holidayNote: 'Online orders processed 24/7. Deliveries dispatched 6 days a week.',
      deliveryApps: 'Steadfast Courier, RedX, Pathao Courier, Paperfly',
      menu: [
        {
          id: 'cat_ec_men',
          name: "Men's Collection",
          items: [
            { id: 'ec1', name: 'Premium Cotton Jacquard Panjabi', desc: '100% fine combed cotton with designer embroidery and metallic buttons', price: 2450, available: true },
            { id: 'ec2', name: 'Semi-Fit Oxford Formal Shirt', desc: 'Wrinkle-resistant breathable cotton formal shirt in classic shades', price: 1650, available: true },
            { id: 'ec3', name: 'Stretch Cotton Slim-Fit Chino Trousers', desc: 'Comfortable everyday casual chinos with reinforced stitching', price: 1850, available: true }
          ]
        },
        {
          id: 'cat_ec_women',
          name: "Women's Collection",
          items: [
            { id: 'ec4', name: 'Designer Embroidered Lawn 3-Piece', desc: 'Luxury printed lawn kameez with digital silk dupatta and matching pants', price: 3200, available: true },
            { id: 'ec5', name: 'Premium Dubai Georgette Abaya', desc: 'Elegant flowy modest silhouette with delicate hand-beaded lace cuffs', price: 4500, available: true },
            { id: 'ec6', name: 'Everyday Casual Printed Kurti', desc: 'Lightweight breathable cotton kurti for daily wear and university', price: 1400, available: true }
          ]
        },
        {
          id: 'cat_ec_acc',
          name: 'Accessories & Leather Goods',
          items: [
            { id: 'ec7', name: 'Handcrafted Full-Grain Leather Wallet', desc: 'Genuine cowhide leather bifold wallet with RFID blocking protection', price: 1250, available: true },
            { id: 'ec8', name: 'Genuine Leather Tassel Loafers', desc: 'Comfort cushioned insole with durable rubberized non-slip sole', price: 3800, available: true }
          ]
        }
      ],
      faqs: [
        { q: `How do I place an order with ${name}?`, a: `You can order directly by sending us a message here with your desired item name/photo, size, delivery address, and phone number. Our AI and team will immediately confirm your order.` },
        { q: `What are your delivery timeframes inside and outside Dhaka?`, a: `Inside Dhaka: 24 to 48 hours. Outside Dhaka (nationwide): 48 to 72 hours via our express courier partners.` },
        { q: `What are your delivery charges and is there free shipping?`, a: `Delivery charge is Tk 70 inside Dhaka and Tk 130 outside Dhaka. We offer FREE nationwide delivery on all orders over Tk 3,000.` },
        { q: `Do you provide Cash on Delivery (COD)?`, a: `Yes, Cash on Delivery (COD) is available all across Bangladesh. You can inspect the package upon arrival and pay cash directly to the delivery rider.` },
        { q: `What is your return and size exchange policy?`, a: `If an item does not fit or you wish to exchange, please notify us within 3 days of receiving the package. We will arrange a hassle-free size exchange through courier.` },
        { q: `What happens if I receive a damaged or incorrect product?`, a: `If you receive a defective or wrong item, inform us immediately with a photo. We will dispatch a brand-new replacement at zero additional shipping cost.` }
      ]
    };
  }

  // 7. EDUCATION, COACHING, ACADEMY & SKILL TRAINING
  if (normType.includes('education') || normType.includes('coaching') || normType.includes('academy') || normType.includes('training') || normType.includes('course') || normType.includes('school') || normType.includes('college') || normType.includes('tuition') || normType.includes('institute')) {
    return {
      serviceDesc: services || 'Academic coaching batches, admission test preparation, professional skill bootcamps, language courses, and certified training',
      holidayNote: 'Admissions open for upcoming batches. Classes conducted both online and offline.',
      deliveryApps: 'Zoom Live Classes, Student Portal LMS, Digital Lecture Notes',
      menu: [
        {
          id: 'cat_edu_acad',
          name: 'Academic & Admission Programs',
          items: [
            { id: 'ed1', name: 'HSC & SSC Special Model Test Batch', desc: 'Topic-wise mock tests, creative solution classes, and revision sheets', price: 3000, available: true },
            { id: 'ed2', name: 'University Admission Preparation Crash Course', desc: 'Comprehensive coaching for Engineering, Medical, or General Universities', price: 8000, available: true },
            { id: 'ed3', name: 'O/A Level Science Comprehensive Coaching', desc: 'Physics, Chemistry & Math curriculum with past paper solving', price: 5000, available: true }
          ]
        },
        {
          id: 'cat_edu_skill',
          name: 'Professional Skill Development',
          items: [
            { id: 'ed4', name: 'Full-Stack Web Development Bootcamp', desc: 'Hands-on practical training in HTML, CSS, JavaScript, React, Node & SQLite', price: 12000, available: true },
            { id: 'ed5', name: 'IELTS Academic & Spoken English Mastery', desc: 'Speaking practice, band-score strategies, mock interviews and feedback', price: 6500, available: true },
            { id: 'ed6', name: 'UI/UX Design with Figma Bootcamp', desc: 'Design thinking, wireframing, mobile app prototyping, and portfolio building', price: 7500, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What courses and coaching programs are available at ${name}?`, a: `We provide academic coaching for SSC/HSC and O/A Levels, University Admission Preparation, and professional skill bootcamps in Web Development, Spoken English & IELTS, and UI/UX Design.` },
        { q: `Are classes conducted in-person, online, or hybrid?`, a: `We offer both options: physical classroom sessions at our campus, and live interactive online batches via Zoom with recorded lecture access in the student portal.` },
        { q: `What is the course fee structure and can I pay in installments?`, a: `Course fees vary from Tk 3,000 for academic batches to Tk 12,000 for professional bootcamps. Convenient 2-month installment payment options are available upon admission.` },
        { q: `Do students receive lecture sheets and study materials?`, a: `Yes, enrolled students receive comprehensive physical lecture sheets, printed problem-solving booklets, daily class quizzes, and full-length weekly mock exams.` },
        { q: `Do you provide a verified certificate upon course completion?`, a: `Yes, students who successfully complete our professional bootcamps and pass the final capstone project receive an industry-recognized certificate of completion.` },
        { q: `How do I enroll in an upcoming batch?`, a: `You can enroll by sending us a message here with your target course and contact details. Our academic advisor will guide you through admission and batch allocation.` }
      ]
    };
  }

  // 8. FITNESS, GYM & WELLNESS
  if (normType.includes('gym') || normType.includes('fitness') || normType.includes('workout') || normType.includes('crossfit') || normType.includes('yoga') || normType.includes('bodybuilding')) {
    return {
      serviceDesc: services || 'State-of-the-art gym facilities, certified personal trainers, muscle building, weight loss programs, cardio, and personalized nutrition charts',
      holidayNote: 'Open 7 days a week. Separate dedicated women-only workout hours available.',
      deliveryApps: 'Digital Fitness App, Online Diet Consultation',
      menu: [
        {
          id: 'cat_gym_mem',
          name: 'Membership Plans',
          items: [
            { id: 'g1', name: '1-Month Unlimited Gym Membership', desc: 'Full access to free weights, strength machines, cardio zone, and lockers', price: 2500, available: true },
            { id: 'g2', name: '3-Month Body Transformation Pass', desc: 'Unlimited access, initial fitness assessment, and baseline diet guide', price: 6500, available: true },
            { id: 'g3', name: '1-Year VIP Executive Membership', desc: 'Annual pass with steam bath access, locker reservation, and guest passes', price: 20000, available: true }
          ]
        },
        {
          id: 'cat_gym_pt',
          name: 'Personal Training & Nutrition',
          items: [
            { id: 'g4', name: '1-on-1 Personal Trainer Package (12 Sessions)', desc: 'Dedicated certified trainer, form correction, and progressive overload tracking', price: 6000, available: true },
            { id: 'g5', name: 'Customized Workout & Diet Nutrition Plan', desc: 'Tailored calorie and macronutrient breakdown for fat loss or muscle gain', price: 2000, available: true },
            { id: 'g6', name: 'InBody Body Composition Analysis', desc: 'Medical-grade body fat %, skeletal muscle mass, and visceral fat scan', price: 500, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What are your gym membership plans and pricing at ${name}?`, a: `We offer monthly (Tk 2,500), 3-month (Tk 6,500), and annual VIP passes (Tk 20,000). There are zero hidden registration fees during current promotional admissions.` },
        { q: `What facilities, equipment, and amenities do you provide?`, a: `Our gym features imported heavy-duty strength equipment, Olympic barbells, dumbells up to 50kg, treadmills, cross-trainers, air-conditioned workout floors, locker rooms, and showers.` },
        { q: `Are there dedicated ladies-only workout hours or female trainers?`, a: `Yes, we have dedicated ladies-only time slots every day guided by certified female fitness trainers with complete privacy.` },
        { q: `Do you offer 1-on-1 personal training packages?`, a: `Yes, our certified personal trainers design tailored routines based on your fitness goals (fat loss, hypertrophy, strength) with 1-on-1 supervised workout sessions.` },
        { q: `Can I try a single workout session before committing to membership?`, a: `Yes, we offer a 1-day trial guest pass so you can experience our facility, equipment, and atmosphere firsthand before signing up.` },
        { q: `Can I pause or freeze my membership if I travel or fall ill?`, a: `Yes, 3-month and annual members can freeze their membership for up to 30 days by notifying our reception in advance.` }
      ]
    };
  }

  // 9. AUTOMOTIVE, CAR REPAIR & DETAILING
  if (normType.includes('auto') || /\b(car|cars|vehicle|vehicles)\b/.test(normType) || normType.includes('automobile') || normType.includes('garage') || normType.includes('workshop') || normType.includes('detailing') || normType.includes('mechanic')) {
    return {
      serviceDesc: services || 'Periodic car maintenance, computerized engine diagnostics, brake and suspension repair, ceramic coating, paint protection, and AC servicing',
      holidayNote: 'Open Saturday through Thursday. Emergency breakdown towing support available.',
      deliveryApps: 'Vehicle Pickup & Drop Service, Mobile Diagnostic Van',
      menu: [
        {
          id: 'cat_auto_maint',
          name: 'Periodic Maintenance & Mechanical',
          items: [
            { id: 'a1', name: 'Comprehensive Periodic Car Servicing', desc: '45-point bumper-to-bumper check, fluid top-up, filter clean & road test', price: 2500, available: true },
            { id: 'a2', name: 'Full Synthetic Engine Oil & Filter Change', desc: 'Premium synthetic motor oil with genuine OEM oil filter replacement', price: 4500, available: true },
            { id: 'a3', name: 'Brake Pad Replacement & Rotor Skimming', desc: 'Front/rear brake pad replacement and computerized rotor disc resurfacing', price: 3000, available: true }
          ]
        },
        {
          id: 'cat_auto_detail',
          name: 'Auto Detailing & Paint Protection',
          items: [
            { id: 'a4', name: 'Multi-Stage Paint Correction & High Gloss Polish', desc: 'Swirl mark removal, dual-action machine polishing, and synthetic sealant', price: 5000, available: true },
            { id: 'a5', name: '9H Nano Ceramic Coating (3-Year Protection)', desc: 'Multi-layer ceramic coating for extreme gloss, hydrophobic finish, and UV shield', price: 18000, available: true },
            { id: 'a6', name: 'Interior Deep Steam Cleaning & Sanitization', desc: 'Seat upholstery shampoo, ceiling steam wash, dashboard rejuvenation & odor removal', price: 3500, available: true }
          ]
        },
        {
          id: 'cat_auto_elec',
          name: 'AC & Computerized Diagnostics',
          items: [
            { id: 'a7', name: 'OBD-II Computerized Engine Diagnostics', desc: 'Live sensor scanning, error code clearing, and electronic systems test', price: 1200, available: true },
            { id: 'a8', name: 'Car AC Complete Servicing & Gas Recharge', desc: 'Cooling coil flush, condenser cleaning, compressor oil and R134a refrigerant charge', price: 3500, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What automotive repair and detailing services are available at ${name}?`, a: `We provide complete periodic maintenance, computerized engine diagnostics, suspension and brake overhauls, car AC servicing, computerized denting & painting, and 9H nano ceramic detailing.` },
        { q: `How do I book a service appointment or schedule a diagnostic check?`, a: `You can book a slot by sending us a message here with your car model, year, and service requirement. Our service advisor will reserve your bay and confirm your time.` },
        { q: `Do you provide genuine OEM spare parts with warranty?`, a: `Yes, we only source 100% genuine and OEM-certified replacement parts. All parts installed come with official supplier warranty.` },
        { q: `What is included in your ceramic coating packages?`, a: `Our 9H ceramic package includes full foam wash, iron decontamination, multi-stage paint correction to remove swirl marks, 2 coats of 9H ceramic coating, and glass hydrophobic treatment.` },
        { q: `Do you offer vehicle pickup and drop-off services?`, a: `Yes, we offer secure doorstep vehicle pickup and delivery across the city for your convenience so you don't need to wait at the workshop.` },
        { q: `Do you provide emergency breakdown or towing assistance?`, a: `Yes, if your car breaks down on the road or won't start, please call our emergency service hotline for prompt recovery support and towing.` }
      ]
    };
  }

  // 10. RESTAURANT, CAFE & BAKERY
  if (normType.includes('cafe') || normType.includes('coffee') || normType.includes('restaurant') || normType.includes('bakery') || normType.includes('bistro') || normType.includes('kitchen') || normType.includes('food') || normType.includes('catering') || normType.includes('burger') || normType.includes('pizza')) {
    return {
      serviceDesc: services || 'Artisan single-origin coffee, handcrafted burgers, authentic continental pastas, fresh bakery pastries, dine-in, takeaway, and delivery',
      holidayNote: 'Open every day including Fridays and public holidays.',
      deliveryApps: 'Foodpanda, Pathao Food',
      menu: [
        {
          id: 'cat_res_bev',
          name: 'Coffee & Specialty Beverages',
          items: [
            { id: 'r1', name: 'Single-Origin Espresso', desc: 'Rich extracted espresso shot with notes of cocoa and roasted hazelnut', price: 180, available: true },
            { id: 'r2', name: 'Velvet Cappuccino', desc: 'Espresso balanced with silky steamed microfoam milk', price: 260, available: true },
            { id: 'r3', name: 'Spanish Iced Latte', desc: 'Espresso poured over chilled sweetened condensed milk and fresh milk', price: 320, available: true }
          ]
        },
        {
          id: 'cat_res_mains',
          name: 'Burgers, Mains & Pastas',
          items: [
            { id: 'r4', name: 'Classic CC Club Sandwich', desc: 'Smoky chicken breast, fried egg, lettuce, cheddar cheese, and French fries', price: 385, available: true },
            { id: 'r5', name: 'Angus Beef Burger', desc: 'Flame-grilled Angus patty with melted cheese, caramelized onions, and house sauce', price: 420, available: true },
            { id: 'r6', name: 'Creamy Fettuccine Alfredo Pasta', desc: 'Fettuccine tossed in rich garlic parmesan cream sauce with grilled chicken and mushrooms', price: 490, available: true }
          ]
        },
        {
          id: 'cat_res_bake',
          name: 'Bakery & Sweet Treats',
          items: [
            { id: 'r7', name: 'Belgian Dark Chocolate Brownie', desc: 'Warm fudgy dark chocolate brownie with chocolate drizzle', price: 220, available: true },
            { id: 'r8', name: 'New York Baked Cheesecake', desc: 'Creamy baked Philadelphia cream cheese slice on a buttery graham crust', price: 360, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What are your specialty food and beverage offerings at ${name}?`, a: `We serve specialty handcrafted espresso beverages, artisan burgers, continental pastas, club sandwiches, fresh bakery desserts, and refreshing mocktails.` },
        { q: `How can I reserve a table or book for a private birthday party?`, a: `You can reserve a table by sending us a message here with your party size, date, and preferred time. For private event arrangements, our team will coordinate customized decor and menu sets.` },
        { q: `Can I order takeaway or get food delivered to my home?`, a: `Yes, takeaway orders can be placed directly here for instant pickup. We are also available for fast doorstep delivery on Foodpanda and Pathao Food.` },
        { q: `Is all your food 100% Halal and do you cater to dietary preferences?`, a: `Yes, all our meats and ingredients are 100% Halal certified. We also offer vegetarian-friendly pastas, salads, and non-dairy milk options (almond/oat milk).` },
        { q: `What are your operating hours and location?`, a: `We are open 7 days a week from 11:00 AM to 11:00 PM. High-speed guest Wi-Fi and power outlets are available for work and study.` },
        { q: `What payment methods are accepted at ${name}?`, a: `We accept Cash, all major Credit/Debit Cards (Visa, Mastercard, Amex), bKash, and Nagad. All prices include applicable VAT.` }
      ]
    };
  }

  // 11. PHOTOGRAPHY, VIDEOGRAPHY & MEDIA STUDIO
  if (normType.includes('photo') || normType.includes('photography') || normType.includes('studio') || normType.includes('video') || normType.includes('cinematography')) {
    return {
      serviceDesc: services || 'Wedding photography, cinematic video production, corporate headshots, studio portraits, fashion shoots, and event coverage',
      holidayNote: 'Studio open by appointment. Available for outdoor and destination shoots nationwide.',
      deliveryApps: 'Private Cloud Gallery, High-Speed Drive Download',
      menu: [
        {
          id: 'cat_ph_wed',
          name: 'Wedding & Celebration Packages',
          items: [
            { id: 'p1', name: 'Cinematic Wedding Photography & Highlight Film', desc: '2 Senior photographers + 1 Cinematographer, full event coverage, and highlight teaser', price: 25000, available: true },
            { id: 'p2', name: 'Holud & Reception Single-Day Coverage', desc: 'Complete candid photography, traditional portraits, and all raw files provided', price: 15000, available: true }
          ]
        },
        {
          id: 'cat_ph_port',
          name: 'Studio Portraits & Commercial',
          items: [
            { id: 'p3', name: 'Professional Corporate Headshot Session', desc: 'Studio lighting, 3 backdrop setups, and 5 fully retouched high-res photos', price: 3000, available: true },
            { id: 'p4', name: 'Family & Maternity Studio Session', desc: '1 Hour studio shoot with multiple wardrobe changes and premium mini photo album', price: 6000, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What photography and video production packages do you offer at ${name}?`, a: `We provide comprehensive wedding and engagement photography, cinematic event films, corporate executive portraits, maternity and family studio sessions, and commercial e-commerce shoots.` },
        { q: `How do I reserve a date for my wedding or corporate event?`, a: `You can check date availability and reserve by messaging us here with your event date, venue, and package requirements. A 30% advance deposit secures your date.` },
        { q: `What is your turnaround delivery time for edited photos and videos?`, a: `Preview photos are shared within 72 hours. Complete edited high-resolution photos and final cinematic video films are delivered within 2 to 3 weeks via a private online cloud gallery.` },
        { q: `Do we get access to all the unedited raw photos?`, a: `Yes, we provide 100% of the raw, high-resolution original JPEG captures along with the retouched album photos on a high-speed cloud drive.` },
        { q: `Do you travel outside the city for destination weddings or shoots?`, a: `Yes, our creative team is available for destination weddings and corporate shoots nationwide. Travel and accommodation are arranged in coordination with the client.` },
        { q: `What happens if I need to postpone or reschedule my booking?`, a: `If you notify us at least 14 days in advance, we will transfer your deposit to any available new date within 6 months with zero penalty.` }
      ]
    };
  }

  // 12. IT SERVICES, SOFTWARE & DIGITAL AGENCY
  if (normType.includes('software') || normType.includes('it') || normType.includes('tech') || normType.includes('agency') || normType.includes('developer') || normType.includes('web') || normType.includes('digital')) {
    return {
      serviceDesc: services || 'Custom web application development, mobile apps, enterprise cloud solutions, UI/UX design, SEO, and AI automation',
      holidayNote: 'Development teams active Sunday to Thursday. 24/7 technical monitoring on live servers.',
      deliveryApps: 'Client Jira Portal, GitHub Repositories, Live Staging Servers',
      menu: [
        {
          id: 'cat_it_dev',
          name: 'Software & Web Development',
          items: [
            { id: 'it1', name: 'Custom Responsive Business Website', desc: 'Modern responsive architecture, SEO-ready, speed optimized with CMS admin', price: 25000, available: true },
            { id: 'it2', name: 'Cross-Platform Mobile App (iOS & Android)', desc: 'Flutter/React Native app with API backend, push notifications and secure auth', price: 60000, available: true },
            { id: 'it3', name: 'E-Commerce Storefront Platform', desc: 'Secure payment gateway integration, inventory tracking, and order management', price: 35000, available: true }
          ]
        },
        {
          id: 'cat_it_growth',
          name: 'Digital Marketing & Product Design',
          items: [
            { id: 'it4', name: 'Comprehensive Monthly SEO Package', desc: 'On-page optimization, technical audit, keyword ranking, and monthly reporting', price: 18000, available: true },
            { id: 'it5', name: 'UI/UX Design System & Interactive Prototype', desc: 'Figma wireframing, high-fidelity UI design system, and clickable user flow prototype', price: 20000, available: true }
          ]
        }
      ],
      faqs: [
        { q: `What software, web development, and digital services does ${name} provide?`, a: `We engineer custom web applications, native & hybrid mobile apps, e-commerce platforms, UI/UX design systems, cloud infrastructure, and search engine optimization (SEO).` },
        { q: `How do we initiate a new project and receive a cost estimate?`, a: `You can share your project requirements by messaging us here. We schedule a brief discovery call and provide a detailed Scope of Work (SOW), timeline milestones, and fixed-price quotation.` },
        { q: `What is your typical project development methodology and timeline?`, a: `We follow an Agile sprint-based workflow with weekly progress demos. Standard websites take 2 to 3 weeks, while comprehensive mobile apps or custom platforms take 6 to 10 weeks.` },
        { q: `How are payment milestones structured?`, a: `Projects are structured into transparent milestones: typically 30% upon kickoff, 40% upon staging milestone approval, and 30% upon final testing, deployment, and handover.` },
        { q: `Do you provide post-launch maintenance, bug fixes, and technical support?`, a: `Yes, all delivered projects include 60 to 90 days of complimentary bug fix warranty and technical support, with optional ongoing monthly maintenance SLA agreements.` },
        { q: `Who owns the source code and intellectual property (IP)?`, a: `Upon project completion and final settlement, 100% full source code ownership, intellectual property rights, and repository access are handed over directly to the client under NDA.` }
      ]
    };
  }

  // 13. DYNAMIC VERSATILE GENERATOR FOR ANY OTHER PROFESSION
  const profTitle = businessType && businessType !== 'General Business' ? businessType : 'Professional Services';
  const cleanServ = services || `${profTitle} solutions, client consultations, customized packages, and reliable customer support`;
  return {
    serviceDesc: cleanServ,
    holidayNote: 'Open during regular business hours. Advance booking or appointment recommended.',
    deliveryApps: 'Online Consultation & Digital Invoicing',
    menu: [
      {
        id: 'cat_core',
        name: `Core ${profTitle} Packages`,
        items: [
          { id: 'p1', name: `Standard ${profTitle} Consultation`, desc: `Detailed assessment, client requirement review & action plan`, price: 1000, available: true },
          { id: 'p2', name: `Comprehensive Service Package`, desc: `Full end-to-end service delivery with dedicated specialist support`, price: 3500, available: true },
          { id: 'p3', name: `Premium / Custom Project`, desc: `Bespoke tailored solution with priority turnaround and warranty`, price: 7500, available: true }
        ]
      }
    ],
    faqs: [
      { q: `What services and solutions does ${name} specialize in?`, a: `We specialize in ${cleanServ}. Contact us directly with your requirements for tailored guidance.` },
      { q: `How do I book a consultation, appointment, or order?`, a: `You can send us a message here with your requested service, name, and contact number. Our team will review your request and confirm with you promptly.` },
      { q: `What is your pricing structure and how do I receive a quote?`, a: `Our standard consultation and packages start from Tk 1,000. For specific or customized requirements, we provide an itemized, transparent quotation before starting work.` },
      { q: `Where are you located and what are your operating hours?`, a: `We operate Saturday through Thursday during standard business hours. Pre-scheduled appointments and inquiries can also be coordinated directly via this chat.` },
      { q: `What is your turnaround time, rescheduling, or cancellation policy?`, a: `We ensure prompt turnaround for all projects and appointments. If you need to reschedule or make adjustments, please notify us at least 4 to 6 hours in advance.` },
      { q: `What payment options do you accept?`, a: `We accept Cash, major Credit/Debit Cards, and Mobile Banking (bKash and Nagad). Official receipts are provided for all transactions.` }
    ]
  };
}

export function makeCleanTemplate(businessName = 'New Business', businessType = 'General Business', services = '') {
  const preset = getIndustryPresets(businessName, businessType, services);
  const bServices = services || preset.serviceDesc;

  return {
    business: {
      name: businessName,
      type: businessType || 'General Business',
      services: bServices,
      phone: '',
      area: '',
      address: '',
      open: '10:00',
      close: '20:00',
      offDay: '',
      holidayNote: preset.holidayNote,
      wifi: 'Available',
      parking: 'Available',
      seating: 'Available',
      payments: 'Cash, Card, Mobile Banking (bKash/Nagad)',
      service: bServices,
      apps: preset.deliveryApps,
      notes: ''
    },
    cafe: {
      name: businessName,
      type: businessType || 'General Business',
      services: bServices,
      phone: '',
      area: '',
      address: '',
      open: '10:00',
      close: '20:00',
      offDay: '',
      holidayNote: preset.holidayNote,
      wifi: 'Available',
      parking: 'Available',
      seating: 'Available',
      payments: 'Cash, Card, Mobile Banking (bKash/Nagad)',
      service: bServices,
      apps: preset.deliveryApps,
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
    menu: preset.menu || [],
    faqs: preset.faqs || [],
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

export function seedWorkspaceIndustry(workspaceId, businessType = 'Dentistry', force = false) {
  const wsId = Number(workspaceId);
  if (!wsId || wsId === 1) return null; // Never override Workspace 1
  const cfg = getWorkspaceConfig(wsId);
  const name = cfg.business?.name || cfg.cafe?.name || `Workspace #${wsId}`;
  const preset = getIndustryPresets(name, businessType, cfg.business?.services || '');

  let modified = false;
  if (force || !cfg.menu || cfg.menu.length === 0) {
    cfg.menu = preset.menu;
    modified = true;
  }
  if (force || !cfg.faqs || cfg.faqs.length === 0) {
    cfg.faqs = preset.faqs;
    modified = true;
  }
  if (businessType) {
    if (!cfg.business) cfg.business = {};
    if (!cfg.cafe) cfg.cafe = {};
    cfg.business.type = businessType;
    cfg.cafe.type = businessType;
    if (!cfg.business.services) cfg.business.services = preset.serviceDesc;
    if (!cfg.cafe.services) cfg.cafe.services = preset.serviceDesc;
    modified = true;
  }

  if (modified) {
    saveWorkspaceConfig(wsId, cfg);
  }
  return cfg;
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
      if (parsed.cafe && parsed.cafe.name === 'Crown Coffee') {
        parsed.cafe.name = 'CC';
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

export function listConversations(workspaceId = null, filters = {}) {
  const wsId = workspaceId ? Number(workspaceId) : null;
  const { q = '', platform = '', from = '', to = '', page = 1, limit = 200 } = filters;
  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);

  const conditions = [];
  const params = [];

  if (wsId) { conditions.push('c.workspace_id = ?'); params.push(wsId); }
  if (platform) { conditions.push('c.platform = ?'); params.push(platform); }
  if (q) { conditions.push('(c.name LIKE ? OR c.psid LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (from) { conditions.push("c.last_msg_at >= ?"); params.push(from); }
  if (to) { conditions.push("c.last_msg_at <= ?"); params.push(to + 'T23:59:59Z'); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(Number(limit), offset);

  return db.prepare(`
    SELECT c.*, (SELECT text FROM messages m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) AS preview
    FROM conversations c
    ${where}
    ORDER BY c.flagged DESC, c.last_msg_at DESC
    LIMIT ? OFFSET ?`).all(...params);
}

export function exportConversationsCSV(workspaceId = null, filters = {}) {
  const rows = listConversations(workspaceId, { ...filters, limit: 5000 });
  const header = 'id,platform,name,psid,last_msg_at,created_at,bot_enabled,flagged,flag_reason,preview';
  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  };
  const lines = rows.map(r =>
    [r.id, r.platform, r.name, r.psid, r.last_msg_at, r.created_at, r.bot_enabled, r.flagged, r.flag_reason, r.preview]
      .map(escape).join(','));
  return [header, ...lines].join('\n');
}

export function exportOrdersCSV(workspaceId) {
  const wsId = Number(workspaceId) || 1;
  const rows = db.prepare('SELECT * FROM orders WHERE workspace_id = ? ORDER BY id DESC').all(wsId);
  const header = 'id,platform,customer_name,customer_phone,customer_address,details,estimated_total,status,notes,created_at,confirmed_at';
  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  };
  const lines = rows.map(r =>
    [r.id, r.platform, r.customer_name, r.customer_phone, r.customer_address, r.details, r.estimated_total, r.status, r.notes, r.created_at, r.confirmed_at]
      .map(escape).join(','));
  return [header, ...lines].join('\n');
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

  // Average bot response time (ms) — time between 'in' and next 'out' in same conversation
  let avgResponseTimeMs = 0;
  try {
    const rtSql = wsId
      ? `SELECT AVG((julianday(o.created_at) - julianday(i.created_at)) * 86400000) as avg_ms
         FROM messages i JOIN messages o ON o.conv_id = i.conv_id AND o.id = (
           SELECT id FROM messages WHERE conv_id = i.conv_id AND id > i.id AND direction = 'out' LIMIT 1
         )
         WHERE i.direction = 'in' AND i.conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)`
      : `SELECT AVG((julianday(o.created_at) - julianday(i.created_at)) * 86400000) as avg_ms
         FROM messages i JOIN messages o ON o.conv_id = i.conv_id AND o.id = (
           SELECT id FROM messages WHERE conv_id = i.conv_id AND id > i.id AND direction = 'out' LIMIT 1
         )
         WHERE i.direction = 'in'`;
    const rtRow = wsId ? db.prepare(rtSql).get(wsId) : db.prepare(rtSql).get();
    avgResponseTimeMs = Math.round(rtRow?.avg_ms || 0);
  } catch {}

  // 7-day heatmap: day(0=Mon..6=Sun) x hour matrix
  let weeklyHeatmap = {};
  try {
    for (let d = 0; d < 7; d++) {
      weeklyHeatmap[d] = {};
      for (let h = 0; h < 24; h++) weeklyHeatmap[d][String(h).padStart(2,'0')] = 0;
    }
    const heatSql = wsId
      ? `SELECT strftime('%w', datetime(created_at, '+6 hours')) as dow,
               strftime('%H', datetime(created_at, '+6 hours')) as hr,
               COUNT(*) as cnt
         FROM messages
         WHERE conv_id IN (SELECT id FROM conversations WHERE workspace_id = ?)
           AND created_at >= datetime('now', '-7 days')
         GROUP BY dow, hr`
      : `SELECT strftime('%w', datetime(created_at, '+6 hours')) as dow,
               strftime('%H', datetime(created_at, '+6 hours')) as hr,
               COUNT(*) as cnt
         FROM messages
         WHERE created_at >= datetime('now', '-7 days')
         GROUP BY dow, hr`;
    const heatRows = wsId ? db.prepare(heatSql).all(wsId) : db.prepare(heatSql).all();
    // SQLite %w: 0=Sun, 1=Mon ... convert to 0=Mon..6=Sun
    for (const r of heatRows) {
      const day = ((Number(r.dow) + 6) % 7);
      if (weeklyHeatmap[day]) weeklyHeatmap[day][r.hr] = r.cnt;
    }
  } catch {}

  // Orders by platform
  let ordersByPlatform = {};
  try {
    const obpSql = wsId
      ? `SELECT platform, COUNT(*) as cnt FROM orders WHERE workspace_id = ? GROUP BY platform`
      : `SELECT platform, COUNT(*) as cnt FROM orders GROUP BY platform`;
    const obpRows = wsId ? db.prepare(obpSql).all(wsId) : db.prepare(obpSql).all();
    for (const r of obpRows) ordersByPlatform[r.platform] = r.cnt;
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
    recent,
    avgResponseTimeMs,
    weeklyHeatmap,
    ordersByPlatform
  };
}

/* ───────── Push Notification Helpers ───────── */

export function savePushSubscription(workspaceId, subscription) {
  const wsId = Number(workspaceId) || 1;
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) throw new Error('Invalid push subscription.');
  db.prepare(`
    INSERT INTO push_subscriptions (workspace_id, endpoint, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET workspace_id = excluded.workspace_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(wsId, endpoint, keys.p256dh, keys.auth, now());
  return { ok: true };
}

export function removePushSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  return { ok: true };
}

export function listPushSubscriptions(workspaceId) {
  const wsId = Number(workspaceId) || 1;
  return db.prepare('SELECT * FROM push_subscriptions WHERE workspace_id = ?').all(wsId);
}

/* ───────── Webhook Log Helpers ───────── */

export function logWebhookEvent(workspaceId, platform, eventType, payloadPreview, status = 'ok', error = null) {
  const wsId = Number(workspaceId) || 1;
  try {
    db.prepare(`
      INSERT INTO webhook_logs (workspace_id, platform, event_type, payload_preview, status, error, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(wsId, platform, eventType, String(payloadPreview || '').slice(0, 500), status, error, now());
    // Prune logs older than 30 days
    db.prepare("DELETE FROM webhook_logs WHERE received_at < datetime('now', '-30 days')").run();
  } catch {}
}

export function listWebhookLogs(workspaceId, limit = 50) {
  const wsId = Number(workspaceId) || 1;
  return db.prepare('SELECT * FROM webhook_logs WHERE workspace_id = ? ORDER BY id DESC LIMIT ?').all(wsId, limit);
}

/* ───────── Custom Domain Helpers ───────── */

export function findWorkspaceByDomain(domain) {
  if (!domain) return null;
  const d = domain.toLowerCase().trim();
  const exact = db.prepare('SELECT * FROM workspaces WHERE LOWER(custom_domain) = ?').get(d);
  if (exact) return exact;

  if (d.endsWith('.ccadmin.online')) {
    const sub = d.replace('.ccadmin.online', '');
    const bySub = db.prepare('SELECT * FROM workspaces WHERE LOWER(custom_domain) = ?').get(sub);
    if (bySub) return bySub;
  }
  return null;
}

export function setWorkspaceCustomDomain(workspaceId, domain) {
  const wsId = Number(workspaceId);
  const d = domain ? domain.toLowerCase().trim() : null;
  if (d) {
    const existing = db.prepare('SELECT id FROM workspaces WHERE custom_domain = ? AND id != ?').get(d, wsId);
    if (existing) throw new Error('This domain is already assigned to another workspace.');
  }
  db.prepare('UPDATE workspaces SET custom_domain = ? WHERE id = ?').run(d, wsId);
  return { ok: true, custom_domain: d };
}

/* ───────── Tenant Auth & Subscription Helpers ───────── */

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const pwd = String(password || '').trim();
  if (storedHash === pwd) return true;
  if (!storedHash.includes(':')) {
    if (storedHash.startsWith('$2')) {
      try { return bcrypt.compareSync(pwd, storedHash); } catch { return false; }
    }
    return storedHash === pwd;
  }
  try {
    const [salt, key] = storedHash.split(':');
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = scryptSync(pwd, salt, 64);
    return timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
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

export function createWorkspaceWithTenant(name, monthlyFee = 500, contactEmail = '', customPassword = null, businessType = 'General Business', services = '', subdomain = '') {
  const ws = createWorkspace(name);
  let cleanSub = String(subdomain || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleanSub) {
    const baseSlug = slugify(name).replace(/[^a-z0-9]/g, '').slice(0, 24) || `tenant${ws.id}`;
    let cand = baseSlug;
    let counter = 1;
    const reserved = ['bot', 'cc', 'admin', 'api', 'app', 'www', 'mail', 'portal', 'status'];
    while (reserved.includes(cand) || db.prepare('SELECT id FROM workspaces WHERE LOWER(custom_domain) = ? AND id != ?').get(cand, ws.id)) {
      counter++;
      cand = `${baseSlug}${counter}`;
    }
    cleanSub = cand;
  }
  db.prepare('UPDATE workspaces SET custom_domain = ? WHERE id = ?').run(cleanSub, ws.id);
  ws.custom_domain = cleanSub;
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

export function authenticateTenant(identifier, password) {
  if (!password) return null;
  const pwd = String(password).trim();
  const idStr = String(identifier || '').trim().toLowerCase();

  // If no identifier is supplied, fall back to password-only authentication
  if (!idStr) {
    return authenticateTenantByPasswordOnly(pwd);
  }

  // Find candidate user by email, contact_email, workspace name, or custom domain
  const candidate = db.prepare(`
    SELECT u.*, w.name as ws_name, s.contact_email as sub_contact_email
    FROM workspace_users u
    JOIN workspaces w ON w.id = u.workspace_id
    LEFT JOIN subscriptions s ON s.workspace_id = u.workspace_id
    WHERE LOWER(u.email) = ?
       OR LOWER(w.name) = ?
       OR LOWER(REPLACE(w.name, ' ', '')) = ?
       OR LOWER(REPLACE(w.name, '-', '')) = ?
       OR LOWER(COALESCE(w.custom_domain, '')) = ?
       OR LOWER(COALESCE(s.contact_email, '')) = ?
    LIMIT 1
  `).get(idStr, idStr, idStr.replace(/\s+/g, ''), idStr.replace(/-/g, ''), idStr, idStr);

  if (candidate) {
    const ok = verifyPassword(pwd, candidate.password_hash) 
            || (candidate.password_display && candidate.password_display === pwd)
            || (candidate.password_hash && candidate.password_hash === pwd);
    if (ok) {
      return {
        id: candidate.id,
        workspace_id: candidate.workspace_id,
        workspace_name: candidate.ws_name,
        email: candidate.email,
        must_change_password: !!candidate.must_change_password,
        role: candidate.role
      };
    }
  }

  // If identifier didn't match directly, still try password-only match across all tenants
  return authenticateTenantByPasswordOnly(pwd);
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

export function authenticateTenantByPasswordOnly(password) {
  if (!password) return null;
  const pwd = String(password).trim();
  const users = db.prepare(`
    SELECT u.*, w.name as ws_name 
    FROM workspace_users u
    JOIN workspaces w ON w.id = u.workspace_id
  `).all();

  for (const u of users) {
    const ok = verifyPassword(pwd, u.password_hash)
            || (u.password_display && u.password_display === pwd)
            || (u.password_hash && u.password_hash === pwd);
    if (ok) {
      return {
        id: u.id,
        workspace_id: u.workspace_id,
        workspace_name: u.ws_name,
        email: u.email,
        must_change_password: !!u.must_change_password,
        role: u.role
      };
    }
  }
  return null;
}

/* ───────── Initializer ───────── */
try {
  const defaultWs = db.prepare('SELECT * FROM workspaces WHERE id = 1').get();
  if (!defaultWs) {
    db.prepare('INSERT INTO workspaces (id, name, created_at, custom_domain) VALUES (1, ?, ?, ?)').run('CC', now(), 'cc.ccadmin.online');
  } else {
    if (defaultWs.name === 'Crown Coffee (Default)' || defaultWs.name === 'Crown Coffee') {
      db.prepare('UPDATE workspaces SET name = ? WHERE id = 1').run('CC');
    }
    if (!defaultWs.custom_domain) {
      db.prepare('UPDATE workspaces SET custom_domain = ? WHERE id = 1').run('cc.ccadmin.online');
    }
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
  } else if (ws1.json && ws1.json.includes('"Crown Coffee"')) {
    const updatedJson = ws1.json.replaceAll('"Crown Coffee"', '"CC"');
    db.prepare('UPDATE workspace_configs SET json = ? WHERE workspace_id = 1').run(updatedJson);
  }
} catch (e) {
  // table exists
}

// Seed or Update Workspace #1 Tenant User (Password: 1590)
try {
  const user1 = db.prepare('SELECT * FROM workspace_users WHERE workspace_id = 1').get();
  const pHash = hashPassword('1590');
  if (!user1) {
    db.prepare(`
      INSERT INTO workspace_users (workspace_id, email, password_hash, password_display, must_change_password, role, created_at, updated_at)
      VALUES (1, 'tenant@cc.local', ?, '1590', 0, 'tenant_admin', ?, ?)
    `).run(pHash, now(), now());
  } else {
    db.prepare(`
      UPDATE workspace_users SET password_hash = ?, password_display = '1590', must_change_password = 0, updated_at = ?
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

// Auto-heal all other workspaces: ensure each has a user and subscription
try {
  const allWorkspaces = db.prepare('SELECT id, name FROM workspaces').all();
  for (const ws of allWorkspaces) {
    if (ws.id === 1) continue;

    let user = db.prepare('SELECT * FROM workspace_users WHERE workspace_id = ?').get(ws.id);
    if (!user) {
      const slug = slugify(ws.name);
      const defaultEmail = `admin@${slug}.com`;
      const pwd = `${slug}@2026`;
      const pHash = hashPassword(pwd);
      db.prepare(`
        INSERT INTO workspace_users (workspace_id, email, password_hash, password_display, must_change_password, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, 'tenant_admin', ?, ?)
      `).run(ws.id, defaultEmail, pHash, pwd, now(), now());
    }

    let sub = db.prepare('SELECT * FROM subscriptions WHERE workspace_id = ?').get(ws.id);
    if (!sub) {
      const trialEnds = new Date(Date.now() + 14 * 86400 * 1000).toISOString();
      db.prepare(`
        INSERT INTO subscriptions (workspace_id, status, plan_name, trial_ends_at, active_until, monthly_fee, contact_email, notes, updated_at)
        VALUES (?, 'trial', '14-Day Free Trial', ?, NULL, 500, '', '', ?)
      `).run(ws.id, trialEnds, now());
    }
  }
} catch (e) {
  console.error('Workspace self-heal notice:', e.message);
}


