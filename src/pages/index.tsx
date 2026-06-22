import type { NextPage } from "next";
import Head from "next/head";

const HomePage: NextPage = () => {
	return (
		<>
			<Head>
				<title>InfinityBio ShipStation</title>
			</Head>
			<main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 720 }}>
				<h1>InfinityBio × ShipStation</h1>
				<p>
					This Saleor app pushes orders to ShipStation when they are created, and writes the
					ShipStation tracking number back to the Saleor order when the package ships.
				</p>
				<p>
					There is no UI to configure here — everything runs via webhooks. Install the app from
					the Saleor Dashboard and inspect <code>/api/manifest</code> to see registered webhooks.
				</p>
			</main>
		</>
	);
};

export default HomePage;
