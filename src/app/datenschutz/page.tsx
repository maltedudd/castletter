export default function DatenschutzPage() {
  return (
    <div className="min-h-screen container max-w-2xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-8">Datenschutzerklärung</h1>

      <div className="space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="text-lg font-semibold mb-2">1. Datenschutz auf einen Blick</h2>
          <p>
            Der Betreiber dieser Website nimmt den Schutz Ihrer persönlichen Daten sehr ernst.
            Wir behandeln Ihre personenbezogenen Daten vertraulich und entsprechend der gesetzlichen
            Datenschutzvorschriften sowie dieser Datenschutzerklärung. Die Nutzung unserer Website
            ist in der Regel ohne Angabe personenbezogener Daten möglich. Soweit auf unseren Seiten
            personenbezogene Daten erhoben werden, erfolgt dies stets auf freiwilliger Basis.
            Diese Daten werden ohne Ihre ausdrückliche Zustimmung nicht an Dritte weitergegeben.
          </p>
          <p className="mt-2">
            Wir weisen darauf hin, dass die Datenübertragung im Internet (z. B. bei der
            Kommunikation per E-Mail) Sicherheitslücken aufweisen kann. Ein lückenloser Schutz der
            Daten vor dem Zugriff durch Dritte ist nicht möglich.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">2. Verantwortliche Stelle</h2>
          <p>
            Verantwortliche Stelle für die Datenverarbeitung auf dieser Website ist:<br /><br />
            JIPIDO MEDIA UG (haftungsbeschränkt)<br />
            Große Brunnenstraße 127a<br />
            22763 Hamburg<br /><br />
            Telefon: 040 41482955<br />
            E-Mail: <a href="mailto:hello@jipido.de" className="underline hover:no-underline">hello@jipido.de</a>
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">3. Registrierung und Nutzerkonto</h2>
          <p>
            Zur Nutzung von Castletter ist eine Registrierung erforderlich. Bei der Registrierung
            erheben wir Ihre E-Mail-Adresse. Diese wird zur Authentifizierung sowie zur Zustellung
            Ihres persönlichen Podcast-Newsletters verwendet. Die Speicherung und Verwaltung der
            Nutzerkonten erfolgt über Supabase (Supabase Inc.), einem Dienst zur Datenbanknutzung
            und Authentifizierung. Ihre Daten werden dabei auf Servern innerhalb der EU gespeichert.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">4. Newsletter-Versand</h2>
          <p>
            Castletter versendet automatisch generierte Newsletter auf Basis von Podcast-Episoden,
            die Sie abonniert haben. Der E-Mail-Versand erfolgt über Resend (Resend Inc.). Dabei
            wird Ihre E-Mail-Adresse an den Versanddienstleister übermittelt, um die Zustellung
            sicherzustellen. Eine Weitergabe Ihrer Daten zu Werbezwecken findet nicht statt.
            Sie können den Newsletter jederzeit durch Löschung Ihres Kontos abbestellen.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">5. Podcast-Daten</h2>
          <p>
            Castletter ruft öffentlich verfügbare RSS-Feeds von Podcasts ab, die Sie abonniert
            haben. Episoden werden automatisch transkribiert und mittels KI zusammengefasst.
            Dabei werden keine personenbezogenen Daten aus den Podcast-Inhalten verarbeitet.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">6. Kontaktformular und E-Mail-Kontakt</h2>
          <p>
            Wenn Sie uns per E-Mail kontaktieren, werden Ihre Angaben zur Bearbeitung der Anfrage
            gespeichert. Diese Daten geben wir nicht ohne Ihre Einwilligung weiter.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">7. Ihre Rechte</h2>
          <p>
            Sie haben jederzeit das Recht auf unentgeltliche Auskunft über Ihre gespeicherten
            personenbezogenen Daten, deren Herkunft und Empfänger sowie den Zweck der
            Datenverarbeitung sowie ein Recht auf Berichtigung, Sperrung oder Löschung dieser
            Daten. Hierzu sowie zu weiteren Fragen zum Thema personenbezogene Daten können Sie
            sich jederzeit unter der im Impressum angegebenen Adresse an uns wenden.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-2">8. Widerspruch gegen Werbe-Mails</h2>
          <p>
            Der Nutzung von im Rahmen der Impressumspflicht veröffentlichten Kontaktdaten zur
            Übersendung von nicht ausdrücklich angeforderter Werbung und Informationsmaterialien
            wird hiermit widersprochen. Die Betreiber der Seiten behalten sich ausdrücklich
            rechtliche Schritte im Falle der unverlangten Zusendung von Werbeinformationen,
            etwa durch Spam-E-Mails, vor.
          </p>
        </section>
      </div>
    </div>
  )
}
