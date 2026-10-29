# Tixy 🤖 — Bot de TixPays

Bot de atención para **WhatsApp e Instagram**, independiente del backend de TixPays.

- **Lee** la base de TixPays con un usuario de MongoDB **de solo lectura**: eventos publicados, precios, disponibilidad, consumiciones y el estado de compra de quien escribe por WhatsApp.
- **Escribe** solo en su propia base (`tixy_bot`): conversaciones, leads de organizadores, alertas de derivación.
- No modifica el backend, no expone códigos de entradas ni datos de otras personas.

## Qué responde

| Consulta | Herramienta | Datos |
|---|---|---|
| Eventos próximos | `buscar_eventos` | `events` publicados + `organizations` |
| Precios / disponibilidad / tragos | `detalle_evento` | `ticket_types`, `products` |
| "Compré y no me llegó" (solo WhatsApp) | `mis_compras` | `users` por teléfono → `payment_intents`, `consumption_orders` |
| Organizadores | `registrar_lead` | escribe en `tixy_bot.leads` |
| Reclamos / pagos | `escalar_a_humano` | `tixy_bot.conversations.humanTakeover` + `tixy_bot.alerts` |

## Estructura

```
app/api/meta/webhook/route.js   Webhook (GET verificación · POST mensajes)
lib/meta.js                      Firma, parser y envío WhatsApp / Instagram
lib/agent.js                     Claude + herramientas + historial
lib/tixpays.js                   Consultas de solo lectura a TixPays
lib/db.js                        Conexiones (TixPays read-only / base del bot)
lib/prompt.js                    Personalidad e instrucciones de Tixy
lib/format.js                    Utilidades (fechas, precios, teléfonos, links)
```

## Variables

Ver `.env.example`. El bot no responde hasta `BOT_ENABLED=true`.

## Operación

- Webhook para Meta: `https://<dominio>/api/meta/webhook` (WhatsApp: campo `messages` · Instagram: `messages` y `comments`).
- Conversación derivada: `tixy_bot.conversations` con `humanTakeover: true`. Para devolverla al bot, poner `false`.
- Leads: `tixy_bot.leads` (nivel A/B/C, estado).
- Logs: Vercel → Logs, filtrar por `[Tixy]`.

## Tests

```bash
npm test
```
