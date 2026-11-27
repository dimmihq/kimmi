// Package geo guesses a visitor's country and city from the IANA time zone
// their browser reports. It is coarse on purpose: kimmi keeps no IP database.
package geo

import "strings"

// Place is where a time zone points.
type Place struct {
	CountryCode string
	Country     string
	City        string
}

type zone struct{ code, city string }

var zones = map[string]zone{
	"Africa/Abidjan": {"CI", "Abidjan"}, "Africa/Accra": {"GH", "Accra"}, "Africa/Addis_Ababa": {"ET", "Addis Ababa"},
	"Africa/Algiers": {"DZ", "Algiers"}, "Africa/Cairo": {"EG", "Cairo"}, "Africa/Casablanca": {"MA", "Casablanca"},
	"Africa/Dar_es_Salaam": {"TZ", "Dar es Salaam"}, "Africa/Johannesburg": {"ZA", "Johannesburg"},
	"Africa/Kampala": {"UG", "Kampala"}, "Africa/Kinshasa": {"CD", "Kinshasa"}, "Africa/Lagos": {"NG", "Lagos"},
	"Africa/Nairobi": {"KE", "Nairobi"}, "Africa/Tunis": {"TN", "Tunis"}, "Africa/Dakar": {"SN", "Dakar"},
	"America/Anchorage": {"US", "Anchorage"}, "America/Argentina/Buenos_Aires": {"AR", "Buenos Aires"},
	"America/Bogota": {"CO", "Bogotá"}, "America/Caracas": {"VE", "Caracas"}, "America/Chicago": {"US", "Chicago"},
	"America/Denver": {"US", "Denver"}, "America/Edmonton": {"CA", "Edmonton"}, "America/Halifax": {"CA", "Halifax"},
	"America/Havana": {"CU", "Havana"}, "America/Lima": {"PE", "Lima"}, "America/Los_Angeles": {"US", "Los Angeles"},
	"America/Mexico_City": {"MX", "Mexico City"}, "America/Montevideo": {"UY", "Montevideo"},
	"America/New_York": {"US", "New York"}, "America/Panama": {"PA", "Panama"}, "America/Phoenix": {"US", "Phoenix"},
	"America/Puerto_Rico": {"PR", "San Juan"}, "America/Santiago": {"CL", "Santiago"},
	"America/Santo_Domingo": {"DO", "Santo Domingo"}, "America/Sao_Paulo": {"BR", "São Paulo"},
	"America/Toronto": {"CA", "Toronto"}, "America/Vancouver": {"CA", "Vancouver"}, "America/Winnipeg": {"CA", "Winnipeg"},
	"America/Guatemala": {"GT", "Guatemala City"}, "America/Costa_Rica": {"CR", "San José"},
	"Asia/Almaty": {"KZ", "Almaty"}, "Asia/Baghdad": {"IQ", "Baghdad"}, "Asia/Bangkok": {"TH", "Bangkok"},
	"Asia/Dhaka": {"BD", "Dhaka"}, "Asia/Dubai": {"AE", "Dubai"}, "Asia/Ho_Chi_Minh": {"VN", "Ho Chi Minh City"},
	"Asia/Hong_Kong": {"HK", "Hong Kong"}, "Asia/Jakarta": {"ID", "Jakarta"}, "Asia/Jerusalem": {"IL", "Jerusalem"},
	"Asia/Karachi": {"PK", "Karachi"}, "Asia/Kathmandu": {"NP", "Kathmandu"}, "Asia/Kolkata": {"IN", "Kolkata"},
	"Asia/Calcutta": {"IN", "Kolkata"}, "Asia/Kuala_Lumpur": {"MY", "Kuala Lumpur"}, "Asia/Manila": {"PH", "Manila"},
	"Asia/Qatar": {"QA", "Doha"}, "Asia/Riyadh": {"SA", "Riyadh"}, "Asia/Seoul": {"KR", "Seoul"},
	"Asia/Shanghai": {"CN", "Shanghai"}, "Asia/Singapore": {"SG", "Singapore"}, "Asia/Taipei": {"TW", "Taipei"},
	"Asia/Tehran": {"IR", "Tehran"}, "Asia/Tokyo": {"JP", "Tokyo"}, "Asia/Tbilisi": {"GE", "Tbilisi"},
	"Asia/Yerevan": {"AM", "Yerevan"}, "Asia/Colombo": {"LK", "Colombo"}, "Asia/Beirut": {"LB", "Beirut"},
	"Asia/Amman":         {"JO", "Amman"},
	"Atlantic/Reykjavik": {"IS", "Reykjavík"}, "Atlantic/Azores": {"PT", "Azores"},
	"Australia/Adelaide": {"AU", "Adelaide"}, "Australia/Brisbane": {"AU", "Brisbane"},
	"Australia/Melbourne": {"AU", "Melbourne"}, "Australia/Perth": {"AU", "Perth"}, "Australia/Sydney": {"AU", "Sydney"},
	"Europe/Amsterdam": {"NL", "Amsterdam"}, "Europe/Athens": {"GR", "Athens"}, "Europe/Belgrade": {"RS", "Belgrade"},
	"Europe/Berlin": {"DE", "Berlin"}, "Europe/Brussels": {"BE", "Brussels"}, "Europe/Bucharest": {"RO", "Bucharest"},
	"Europe/Budapest": {"HU", "Budapest"}, "Europe/Copenhagen": {"DK", "Copenhagen"}, "Europe/Dublin": {"IE", "Dublin"},
	"Europe/Helsinki": {"FI", "Helsinki"}, "Europe/Istanbul": {"TR", "Istanbul"}, "Europe/Kiev": {"UA", "Kyiv"},
	"Europe/Kyiv": {"UA", "Kyiv"}, "Europe/Lisbon": {"PT", "Lisbon"}, "Europe/London": {"GB", "London"},
	"Europe/Madrid": {"ES", "Madrid"}, "Europe/Milan": {"IT", "Milan"}, "Europe/Moscow": {"RU", "Moscow"},
	"Europe/Oslo": {"NO", "Oslo"}, "Europe/Paris": {"FR", "Paris"}, "Europe/Prague": {"CZ", "Prague"},
	"Europe/Rome": {"IT", "Rome"}, "Europe/Sofia": {"BG", "Sofia"}, "Europe/Stockholm": {"SE", "Stockholm"},
	"Europe/Tallinn": {"EE", "Tallinn"}, "Europe/Vienna": {"AT", "Vienna"}, "Europe/Vilnius": {"LT", "Vilnius"},
	"Europe/Riga": {"LV", "Riga"}, "Europe/Warsaw": {"PL", "Warsaw"}, "Europe/Zurich": {"CH", "Zurich"},
	"Europe/Zagreb": {"HR", "Zagreb"}, "Europe/Luxembourg": {"LU", "Luxembourg"},
	"Pacific/Auckland": {"NZ", "Auckland"}, "Pacific/Honolulu": {"US", "Honolulu"}, "Pacific/Fiji": {"FJ", "Suva"},
}

var countries = map[string]string{
	"AE": "United Arab Emirates", "AM": "Armenia", "AR": "Argentina", "AT": "Austria", "AU": "Australia",
	"BD": "Bangladesh", "BE": "Belgium", "BG": "Bulgaria", "BR": "Brazil", "CA": "Canada", "CD": "DR Congo",
	"CH": "Switzerland", "CI": "Côte d'Ivoire", "CL": "Chile", "CN": "China", "CO": "Colombia", "CR": "Costa Rica",
	"CU": "Cuba", "CZ": "Czechia", "DE": "Germany", "DK": "Denmark", "DO": "Dominican Republic", "DZ": "Algeria",
	"EE": "Estonia", "EG": "Egypt", "ES": "Spain", "ET": "Ethiopia", "FI": "Finland", "FJ": "Fiji", "FR": "France",
	"GB": "United Kingdom", "GE": "Georgia", "GH": "Ghana", "GR": "Greece", "GT": "Guatemala", "HK": "Hong Kong",
	"HR": "Croatia", "HU": "Hungary", "ID": "Indonesia", "IE": "Ireland", "IL": "Israel", "IN": "India", "IQ": "Iraq",
	"IR": "Iran", "IS": "Iceland", "IT": "Italy", "JO": "Jordan", "JP": "Japan", "KE": "Kenya", "KR": "South Korea",
	"KZ": "Kazakhstan", "LB": "Lebanon", "LK": "Sri Lanka", "LT": "Lithuania", "LU": "Luxembourg", "LV": "Latvia",
	"MA": "Morocco", "MX": "Mexico", "MY": "Malaysia", "NG": "Nigeria", "NL": "Netherlands", "NO": "Norway",
	"NP": "Nepal", "NZ": "New Zealand", "PA": "Panama", "PE": "Peru", "PH": "Philippines", "PK": "Pakistan",
	"PL": "Poland", "PR": "Puerto Rico", "PT": "Portugal", "QA": "Qatar", "RO": "Romania", "RS": "Serbia",
	"RU": "Russia", "SA": "Saudi Arabia", "SE": "Sweden", "SG": "Singapore", "SN": "Senegal", "TH": "Thailand",
	"TN": "Tunisia", "TR": "Türkiye", "TW": "Taiwan", "TZ": "Tanzania", "UA": "Ukraine", "UG": "Uganda",
	"US": "United States", "UY": "Uruguay", "VE": "Venezuela", "VN": "Vietnam", "ZA": "South Africa",
}

// FromTimezone returns the place a time zone stands for. Unknown zones keep the
// city part of the name ("America/Boise" gives "Boise") and no country.
func FromTimezone(tz string) Place {
	if z, ok := zones[tz]; ok {
		return Place{CountryCode: z.code, Country: countries[z.code], City: z.city}
	}
	if i := strings.LastIndexByte(tz, '/'); i >= 0 && i < len(tz)-1 {
		return Place{City: strings.ReplaceAll(tz[i+1:], "_", " ")}
	}
	return Place{}
}

// CountryName returns the English name of an ISO 3166 code, or "" when unknown.
func CountryName(code string) string { return countries[code] }
