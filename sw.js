/* ==========================================================================
   sw.js — Service Worker приложения "Дни рождения"
   --------------------------------------------------------------------------
   Задача этого файла: работать в фоне (даже когда сайт закрыт) и раз в сутки
   проверять список людей. Уведомление показывается каждый день, начиная
   ЗА 5 ДНЕЙ до дня рождения человека и до самого праздника: "через 5 дней",
   на следующий день "через 4 дня", ..., "через 1 день", и в сам день —
   "сегодня". В каждом уведомлении также указывается, сколько лет исполняется
   человеку в этот день рождения (возраст считается на основе текущей даты
   устройства, поэтому математика остаётся верной в любом году, включая 2026).

   ВАЖНО (техническое ограничение браузеров):
   У Service Worker'а НЕТ доступа к localStorage — это API работает только
   внутри обычной открытой страницы. Поэтому мы храним собственную копию
   списка людей в IndexedDB (это хранилище, в отличие от localStorage,
   доступно и из фонового Service Worker'а). Страница (index.html) должна
   при каждом изменении списка отправлять сюда свежие данные через
   postMessage — сообщение с type: 'SYNC_PEOPLE' (см. обработчик 'message'
   ниже). Без этого шага в index.html Service Worker будет "не в курсе"
   списка людей.
   ========================================================================== */

const DB_NAME = 'birthdayAppSW';       // имя базы IndexedDB внутри Service Worker'а
const STORE_NAME = 'people';           // название "хранилища" в базе
const PERIODIC_SYNC_TAG = 'check-birthdays'; // метка задачи фоновой проверки
const NOTIFY_DAYS_BEFORE = 5;          // за сколько дней до праздника начинаем напоминать (5, 4, 3, 2, 1, 0)

/**
 * Открывает (и при первом запуске создаёт) базу IndexedDB,
 * в которой Service Worker хранит свою копию списка людей.
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Сохраняет список людей (присланный со страницы через postMessage)
 * в IndexedDB, чтобы он был доступен даже когда сайт закрыт.
 */
async function savePeople(people) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(people, 'list');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Читает сохранённый список людей из IndexedDB.
 * Если данных ещё нет — возвращает пустой массив.
 */
async function loadPeople() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('list');
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Считает, сколько дней осталось до следующего дня рождения человека.
 * Логика полностью повторяет функцию daysUntilBirthday() из index.html,
 * чтобы уведомления совпадали с тем, что видно на экране приложения.
 */
function daysUntilBirthday(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const birthDate = new Date(dateStr);
  let nextBirthday = new Date(today.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  nextBirthday.setHours(0, 0, 0, 0);

  if (nextBirthday < today) {
    nextBirthday.setFullYear(today.getFullYear() + 1);
  }

  const diffMs = nextBirthday - today;
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Считает, сколько лет ИСПОЛНИТСЯ человеку в его ближайший день рождения.
 * Логика полностью повторяет calculateUpcomingAge() из index.html: строим
 * дату ближайшего дня рождения (в этом году или в следующем, если в этом
 * году уже прошёл) и вычитаем год рождения из года этой даты. Расчёт всегда
 * опирается на текущую дату устройства (new Date()), поэтому он одинаково
 * верен и в 2026 году, и в любой другой год — никаких "зашитых" чисел нет.
 */
function calculateUpcomingAge(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const birthDate = new Date(dateStr);
  let nextBirthday = new Date(today.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  nextBirthday.setHours(0, 0, 0, 0);

  if (nextBirthday < today) {
    nextBirthday.setFullYear(today.getFullYear() + 1);
  }

  return nextBirthday.getFullYear() - birthDate.getFullYear();
}

/**
 * Правильно склоняет слово "год" по-русски в зависимости от возраста:
 * 1 год, 2/3/4 года, 5-20 лет, 21 год, 22 года и т.д.
 */
function pluralizeYears(age) {
  const lastTwoDigits = age % 100;
  const lastDigit = age % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return 'лет';
  }
  if (lastDigit === 1) {
    return 'год';
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return 'года';
  }
  return 'лет';
}

/**
 * Правильно склоняет слово "день" по-русски в зависимости от числа дней:
 * 1 день, 2/3/4 дня, 5-20 дней, 21 день, 22 дня и т.д.
 */
function pluralizeDays(days) {
  const absDays = Math.abs(days);
  const lastTwoDigits = absDays % 100;
  const lastDigit = absDays % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return 'дней';
  }
  if (lastDigit === 1) {
    return 'день';
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return 'дня';
  }
  return 'дней';
}

/**
 * Формирует заголовок и текст уведомления в зависимости от того,
 * сколько дней осталось до дня рождения человека, и сколько лет
 * ему исполняется в этот день рождения.
 */
function buildNotificationContent(person, daysLeft, upcomingAge) {
  const ageText = `исполняется ${upcomingAge} ${pluralizeYears(upcomingAge)}`;

  if (daysLeft === 0) {
    return {
      title: '🎉 День рождения сегодня!',
      body: `У ${person.name} сегодня день рождения, ${ageText}!`
    };
  }

  return {
    title: '🎂 Скоро день рождения!',
    body: `У ${person.name} через ${daysLeft} ${pluralizeDays(daysLeft)} день рождения, ${ageText}!`
  };
}

/**
 * Главная фоновая проверка: смотрит весь список людей и показывает
 * стандартное системное уведомление для каждого, у кого день рождения
 * наступает сегодня или в ближайшие NOTIFY_DAYS_BEFORE дней.
 * Уведомления приходят каждый день в этом диапазоне, например:
 * "через 5 дней" -> "через 4 дня" -> ... -> "через 1 день" -> "сегодня",
 * и в каждом из них указывается точный исполняющийся возраст.
 */
async function checkBirthdaysAndNotify() {
  const people = await loadPeople();

  const upcomingPeople = people
    .map((person) => ({ person, daysLeft: daysUntilBirthday(person.date) }))
    .filter(({ daysLeft }) => daysLeft >= 0 && daysLeft <= NOTIFY_DAYS_BEFORE);

  for (const { person, daysLeft } of upcomingPeople) {
    const upcomingAge = calculateUpcomingAge(person.date);
    const { title, body } = buildNotificationContent(person, daysLeft, upcomingAge);

    await self.registration.showNotification(title, {
      body,
      // tag включает daysLeft, поэтому каждый день (5, 4, 3, 2, 1, 0) считается
      // ОТДЕЛЬНЫМ уведомлением и не подавляется вчерашним с тем же id человека
      tag: `birthday-${person.id}-${daysLeft}`,
      requireInteraction: false
    });
  }
}

/* ===================== СТАНДАРТНЫЕ СОБЫТИЯ SERVICE WORKER'А ===================== */

// Устанавливается сразу, не дожидаясь закрытия всех старых вкладок сайта
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Начинает управлять страницей сразу после активации
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Страница присылает сюда актуальный список людей (после каждого
 * добавления/удаления), чтобы Service Worker знал, кого проверять,
 * даже если сайт в этот момент закрыт.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SYNC_PEOPLE') {
    event.waitUntil(savePeople(event.data.people));
  }
});

/**
 * Periodic Background Sync — браузер сам вызывает этот код примерно раз
 * в сутки, даже если сайт не открыт. Поддерживается пока только в
 * Chrome/Edge на Android и только если сайт установлен как PWA на главный
 * экран (плюс сайт должен отдаваться по HTTPS).
 */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(checkBirthdaysAndNotify());
  }
});

/**
 * Обычный (одноразовый) Background Sync — резервный вариант там, где
 * Periodic Background Sync недоступен. Может быть запущен, например,
 * при восстановлении интернет-соединения.
 */
self.addEventListener('sync', (event) => {
  if (event.tag === PERIODIC_SYNC_TAG) {
    event.waitUntil(checkBirthdaysAndNotify());
  }
});

/**
 * Клик по уведомлению открывает вкладку с приложением
 * (или переключает на уже открытую).
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        return existing.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
