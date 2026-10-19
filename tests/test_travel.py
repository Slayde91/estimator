"""Google requests are synthetic: no credentials, locations or paid calls."""
from contextlib import contextmanager
import json
import unittest
from urllib.error import HTTPError
from estimator.catalog import ValidationError
from estimator.travel import TravelService, TravelError, ENDPOINT

KEY='synthetic-route-key-for-tests-only'
BODY={'origin':{'address':'Fixture origin'},'destination':'Fixture destination'}


class Provider:
    def __init__(self, payload=None, raw=None, error=None):
        self.raw=raw if raw is not None else json.dumps(payload or {'routes':[{'distanceMeters':12345,'duration':'1800s','description':'Fixture Road'}]}).encode()
        self.error=error;self.requests=[]

    @contextmanager
    def __call__(self, request, timeout):
        self.requests.append((request,timeout))
        if self.error:raise self.error
        owner=self
        class Response:
            def read(self,limit):return owner.raw[:limit]
        yield Response()


class TravelTests(unittest.TestCase):
    def test_route_payload_endpoint_and_minimum_response(self):
        provider=Provider();service=TravelService(key=KEY,opener=provider)
        result=service.route(BODY)
        self.assertEqual(result,{'provider':'Google Maps','distance_meters':12345,'duration_seconds':1800.0,'summary':'Fixture Road'})
        request,timeout=provider.requests[0]
        self.assertEqual(request.full_url,ENDPOINT);self.assertEqual(timeout,10)
        self.assertEqual(request.get_method(),'POST')
        body=json.loads(request.data)
        self.assertEqual(body['origin'],BODY['origin']);self.assertEqual(body['destination'],{'address':BODY['destination']})
        self.assertEqual(body['travelMode'],'DRIVE');self.assertEqual(body['routingPreference'],'TRAFFIC_UNAWARE')
        self.assertEqual(request.get_header('X-goog-api-key'),KEY)
        self.assertEqual(request.get_header('X-goog-fieldmask'),'routes.distanceMeters,routes.duration,routes.description')
        self.assertNotIn(KEY,json.dumps(service.status())+json.dumps(result))

    def test_coordinates_and_zero_distance_are_valid(self):
        provider=Provider({'routes':[{'distanceMeters':0,'duration':'0.5s'}]})
        result=TravelService(key=KEY,opener=provider).route({**BODY,'origin':{'latitude':-33.86,'longitude':151.2}})
        self.assertEqual(result['distance_meters'],0);self.assertEqual(result['duration_seconds'],.5)
        self.assertEqual(json.loads(provider.requests[0][0].data)['origin'],{'location':{'latLng':{'latitude':-33.86,'longitude':151.2}}})

    def test_missing_key_makes_no_outbound_request(self):
        provider=Provider();service=TravelService(key='',opener=provider)
        with self.assertRaises(TravelError) as error:service.route(BODY)
        self.assertEqual(error.exception.status,503);self.assertFalse(service.status()['configured']);self.assertEqual(provider.requests,[])

    def test_invalid_inputs_make_no_outbound_request(self):
        cases=[None,{},dict(BODY,url='https://example.invalid'),{**BODY,'destination':' '},{**BODY,'destination':'x'*401},{**BODY,'destination':'x\ny'},
               {**BODY,'origin':{'latitude':True,'longitude':0}},{**BODY,'origin':{'latitude':float('nan'),'longitude':0}},
               {**BODY,'origin':{'latitude':91,'longitude':0}},{**BODY,'origin':{'latitude':0,'longitude':181}},
               {**BODY,'origin':{'address':'Fixture','key':'ignored'}},{**BODY,'origin':{'address':''}}]
        for body in cases:
            with self.subTest(body=body):
                provider=Provider()
                with self.assertRaises(ValidationError):TravelService(key=KEY,opener=provider).route(body)
                self.assertEqual(provider.requests,[])

    def test_provider_errors_are_sanitised_and_lock_is_released(self):
        provider=Provider(error=HTTPError(ENDPOINT,403,KEY+' private location',{},None))
        service=TravelService(key=KEY,opener=provider,clock=lambda:10)
        with self.assertRaises(TravelError) as error:service.route(BODY)
        self.assertNotIn(KEY,str(error.exception));self.assertNotIn('private location',str(error.exception))
        self.assertTrue(service._lock.acquire(blocking=False));service._lock.release()

    def test_unusable_provider_responses_are_explicit(self):
        for payload in [[],{}, {'routes':None},{'routes':[{'distanceMeters':-1,'duration':'1s'}]},
                        {'routes':[{'distanceMeters':True,'duration':'1s'}]},{'routes':[{'distanceMeters':10,'duration':'NaNs'}]},
                        {'routes':[{'distanceMeters':10,'duration':'1s','description':{}}]}]:
            with self.subTest(payload=payload),self.assertRaises(TravelError):TravelService(key=KEY,opener=Provider(raw=json.dumps(payload).encode())).route(BODY)
        for raw in [b'not JSON',b' '*65537]:
            with self.assertRaises(TravelError):TravelService(key=KEY,opener=Provider(raw=raw)).route(BODY)
        with self.assertRaises(TravelError) as error:TravelService(key=KEY,opener=Provider(raw=b'{"routes":[]}')).route(BODY)
        self.assertEqual(error.exception.status,422)

    def test_rate_limit_and_parallel_requests_do_not_repeat_paid_calls(self):
        provider=Provider();service=TravelService(key=KEY,opener=provider,clock=lambda:10)
        service.route(BODY)
        with self.assertRaises(TravelError) as error:service.route(BODY)
        self.assertEqual(error.exception.status,429);self.assertEqual(len(provider.requests),1)
        service._lock.acquire()
        try:
            with self.assertRaises(TravelError) as error:service.route(BODY)
            self.assertEqual(error.exception.status,429)
        finally:service._lock.release()


if __name__=='__main__':unittest.main()
