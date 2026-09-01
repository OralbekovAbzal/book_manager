-- Минимальные начальные данные для СВЕЖЕЙ установки хоста (пустая база).
-- Если на хост переносится существующая база — этот seed не нужен.
-- ВНИМАНИЕ: дефолтный логин admin / admin123 — сменить после первого входа!

INSERT INTO "Admin" (username, password, name, role, "isActive", "createdAt", "updatedAt")
VALUES ('admin', '$2a$12$//n4WqFXriARMzPggxBw3.k8BNn5YTFmI9I2SJgQwjLDSUgYt4ENS',
        'Главный администратор', 'SUPER_ADMIN', true, NOW(), NOW())
ON CONFLICT (username) DO NOTHING;

INSERT INTO "Category" (name, color, description) VALUES
  ('Люкс',     '#D4A8E1', 'Люкс апартаменты'),
  ('Полулюкс', '#B5D4F4', 'Улучшенный номер'),
  ('Стандарт', '#C0DD97', 'Стандартный номер'),
  ('Эконом',   '#FAC775', 'Эконом класс')
ON CONFLICT (name) DO NOTHING;

INSERT INTO "BookingFlag" (code, label, color, effects, "order", "createdAt", "updatedAt") VALUES
  ('late_checkout', 'Поздний выезд', '#F4A8A8', '{"bufferAfter":1}', 1, NOW(), NOW()),
  ('vip',           'VIP',           '#E1C84A', '{}',                2, NOW(), NOW()),
  ('no_move',       'Не перемещать', '#A8C8F4', '{"pin":true}',      3, NOW(), NOW())
ON CONFLICT (code) DO NOTHING;
